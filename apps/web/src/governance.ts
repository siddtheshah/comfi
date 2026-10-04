import { Buffer } from 'buffer'
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, type AccountMeta } from '@solana/web3.js'
import { decodePoolAccountData, fetchVaultBalanceAtomic, formatUsdc, toBase58, type OnChainPool, type ExecutionMode } from './solana.ts'

export const proposalKinds = ['SetSpenderLimit', 'ApproveWithdrawal', 'ConfigurationModification', 'ClosePool', 'EvictMember', 'AdmitMember'] as const
export type ProposalKind = typeof proposalKinds[number]
export type Configuration = {
  voteThreshold: number; cycleDurationSeconds: bigint; memberObligationAmount: bigint
  spenderLimitDeadlineCycles: bigint; withdrawalDeadlineCycles: bigint; configModificationDeadlineCycles: bigint
  spenderLimitExecutionMode: ExecutionMode; withdrawalExecutionMode: ExecutionMode; configModificationExecutionMode: ExecutionMode
}
export type ProposalAction =
  | { kind: 'SetSpenderLimit'; member: string; cap: bigint }
  | { kind: 'ApproveWithdrawal'; request: string }
  | ({ kind: 'ConfigurationModification' } & Configuration)
  | { kind: 'ClosePool' }
  | { kind: 'EvictMember'; member: string }
  | { kind: 'AdmitMember'; candidateWallet: string; vouchedBy: string }
export type ProposalState = 'Queued' | 'Open' | 'Executable' | 'Executed' | 'Rejected'
export type Proposal = { address: string; pool: string; id: bigint; proposer: string; action: ProposalAction; yesVotes: number; noVotes: number; votingCycle: bigint; deadlineCycle: bigint; executableCycle: bigint; deadline: bigint; executableAfter: bigint; state: ProposalState; executionMode: ExecutionMode; voteThreshold: number }
export type VotingMember = { address: string; pool: string; wallet: string; role: string; isFunded: boolean; depositedTotal: bigint; totalContributions: bigint; fundedCycle: bigint; isPaused: boolean; nextMember: string | null; status: string; fundedCycleStreak: bigint; isMaturedVoter: boolean }
export type Withdrawal = { address: string; pool: string; requester: string; recipient: string; amount: bigint; requiresProposal: boolean; status: string }
export type GovernanceSnapshot = { pool: OnChainPool; proposals: Proposal[]; members: VotingMember[]; withdrawals: Withdrawal[]; receipts: { proposal: string; voter: string }[]; now: bigint }
const discriminators = {
  Proposal: [26,94,189,187,116,136,53,33], Member: [54,19,162,21,29,166,17,198],
  WithdrawalRequest: [242,88,147,173,182,62,229,193], VoteReceipt: [104,20,204,252,45,84,37,195],
}
class Reader {
  offset = 8
  view: DataView
  bytes: Uint8Array
  constructor(bytes: Uint8Array, name: keyof typeof discriminators) {
    this.bytes = bytes
    if (!discriminators[name].every((v, i) => bytes[i] === v)) throw new Error(`Invalid ${name} discriminator`)
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  take(n: number) { const start = this.offset; if (start + n > this.bytes.length) throw new Error('Truncated governance account'); this.offset += n; return start }
  u8() { return this.view.getUint8(this.take(1)) }
  u32() { return this.view.getUint32(this.take(4), true) }
  u64() { return this.view.getBigUint64(this.take(8), true) }
  i64() { return this.view.getBigInt64(this.take(8), true) }
  key() { return toBase58(this.bytes.subarray(this.take(32), this.offset)) }
  enum<T>(values: readonly T[]): T { const value = values[this.u8()]; if (value === undefined) throw new Error('Invalid governance enum tag'); return value }
  bool() { return this.enum([false, true]) }
  mode(): ExecutionMode { return this.enum(['on_deadline', 'threshold_met'] as const) }
  optionKey() { return this.bool() ? this.key() : null }
}
export function decodeProposal(address: string, bytes: Uint8Array): Proposal {
  new PublicKey(address)
  const r = new Reader(bytes, 'Proposal')
  const pool = r.key(), id = r.u64(), proposer = r.key(), kind = r.enum(proposalKinds)
  let action: ProposalAction
  switch (kind) {
    case 'SetSpenderLimit': action = { kind, member: r.key(), cap: r.u64() }; break
    case 'ApproveWithdrawal': action = { kind, request: r.key() }; break
    case 'EvictMember': action = { kind, member: r.key() }; break
    case 'AdmitMember': action = { kind, candidateWallet: r.key(), vouchedBy: r.key() }; break
    case 'ClosePool': action = { kind }; break
    case 'ConfigurationModification': action = { kind, voteThreshold: r.u32(), cycleDurationSeconds: r.i64(), memberObligationAmount: r.u64(), spenderLimitDeadlineCycles: r.u64(), withdrawalDeadlineCycles: r.u64(), configModificationDeadlineCycles: r.u64(), spenderLimitExecutionMode: r.mode(), withdrawalExecutionMode: r.mode(), configModificationExecutionMode: r.mode() }; break
  }
  const yesVotes = r.u32(), noVotes = r.u32(), votingCycle = r.u64(), deadlineCycle = r.u64(), executableCycle = r.u64(), deadline = r.i64(), executableAfter = r.i64()
  const state = r.enum(['Queued', 'Open', 'Executable', 'Executed', 'Rejected'] as const)
  r.u8() // bump
  const executionMode = r.mode(), voteThreshold = r.u32()
  if (voteThreshold < 100 || voteThreshold > 10_000) throw new Error('Invalid proposal vote threshold')
  return { address, pool, id, proposer, action, yesVotes, noVotes, votingCycle, deadlineCycle, executableCycle, deadline, executableAfter, state, executionMode, voteThreshold }
}
export function decodeVotingMember(address: string, bytes: Uint8Array): VotingMember {
  new PublicKey(address)
  const r = new Reader(bytes, 'Member')
  const pool = r.key(), wallet = r.key(), role = r.enum(['Member', 'Spender', 'Admin']), isFunded = r.bool(), depositedTotal = r.u64()
  r.take(32 + 32 + 4 + 8 + 8 + 1 + 8 + 8 + 1 + 16 + 8)
  const totalContributions = r.u64(); r.u64()
  const fundedCycle = r.u64(), isPaused = r.bool(), nextMember = r.optionKey(), status = r.enum(['Active', 'Leaving', 'Exited', 'Evicted'])
  r.u64(); r.optionKey(); r.u32(); r.u32(); r.u64()
  const fundedCycleStreak = r.u64(), isMaturedVoter = r.bool()
  return { address, pool, wallet, role, isFunded, depositedTotal, totalContributions, fundedCycle, isPaused, nextMember, status, fundedCycleStreak, isMaturedVoter }
}
export function decodeWithdrawal(address: string, bytes: Uint8Array): Withdrawal {
  new PublicKey(address)
  const r = new Reader(bytes, 'WithdrawalRequest')
  const pool = r.key(); r.u64()
  const requester = r.key(), recipient = r.key(), amount = r.u64(); r.take(32)
  return { address, pool, requester, recipient, amount, requiresProposal: r.bool(), status: r.enum(['Pending', 'Spent', 'Cancelled']) }
}
export async function fetchGovernance(connection: Connection, programId: string, address: string): Promise<GovernanceSnapshot> {
  const program = new PublicKey(programId), key = new PublicKey(address)
  const info = await connection.getAccountInfo(key, 'confirmed')
  if (!info || !info.owner.equals(program)) throw new Error('Pool account missing or owned by another program')
  const decoded = decodePoolAccountData(address, info.data)
  const balance = await fetchVaultBalanceAtomic(connection.rpcEndpoint, decoded.vault)
  const lists = await Promise.all((['Proposal', 'Member', 'WithdrawalRequest'] as const).map(name => connection.getProgramAccounts(program, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: toBase58(Uint8Array.from(discriminators[name])) } }, { memcmp: { offset: 8, bytes: address } }] })))
  const proposals = lists[0].map(a => decodeProposal(a.pubkey.toBase58(), a.account.data)).sort((a,b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
  const members = lists[1].map(a => decodeVotingMember(a.pubkey.toBase58(), a.account.data))
  const withdrawals = lists[2].map(a => decodeWithdrawal(a.pubkey.toBase58(), a.account.data))
  const receiptLists = await Promise.all(proposals.map(p => connection.getProgramAccounts(program, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: toBase58(Uint8Array.from(discriminators.VoteReceipt)) } }, { memcmp: { offset: 8, bytes: p.address } }] })))
  const receipts = receiptLists.flat().map(a => { const r = new Reader(a.account.data, 'VoteReceipt'); const proposal = r.key(), voter = r.key(); r.bool(); r.u8(); return { proposal, voter } })
  const slot = await connection.getSlot('confirmed'), time = await connection.getBlockTime(slot)
  if (time === null) throw new Error('RPC did not provide chain time')
  return { pool: { ...decoded, vaultBalanceAtomic: balance, balanceUsdc: formatUsdc(balance) }, proposals, members, withdrawals, receipts, now: BigInt(time) }
}
function metrics(pool: OnChainPool) { if (!pool.metrics) throw new Error('Governance requires the current pool account layout'); return pool.metrics }
export function requiredVotes(pool: OnChainPool, p: Proposal): number {
  const m = metrics(pool)
  if (!Number.isInteger(p.voteThreshold) || p.voteThreshold < 100 || p.voteThreshold > 10_000) throw new Error('Invalid proposal vote threshold')
  const critical = ['SetSpenderLimit', 'ConfigurationModification', 'EvictMember'].includes(p.action.kind)
  const bps = Math.max(p.voteThreshold, critical ? 6667 : 5001)
  const base = m.votingMemberCount || m.fundedMemberCount
  const count = p.action.kind === 'ClosePool' ? (m.fundedMemberCount || pool.memberCount) : p.action.kind === 'EvictMember' ? base - 1 : base
  return Math.max(1, Math.ceil(Math.max(1, count) * bps / 10_000))
}
export function proposalEligibility(pool: OnChainPool, p: Proposal, now: bigint) {
  if (p.pool !== pool.address) throw new Error('Proposal belongs to another pool')
  if (typeof now !== 'bigint' || now < 0n) throw new Error('Invalid chain time')
  const m = metrics(pool), required = requiredVotes(pool, p), passed = p.yesVotes >= required && p.yesVotes > p.noVotes
  const cycleCurrent = pool.testingEnabled || m.isClosing || (!m.rolloverCursor && now < pool.cycleStartedAt + pool.cycleDurationSeconds)
  const allowed = cycleCurrent && (!m.isLocked || p.action.kind === 'ClosePool')
  const pending = p.state === 'Queued' || p.state === 'Open'
  const canFinalize = allowed && pending && (pool.currentCycle > p.deadlineCycle || (p.executionMode === 'threshold_met' && passed))
  const canExecute = allowed && p.state === 'Executable' && pool.currentCycle >= p.executableCycle && now >= p.executableAfter && (!m.isClosing || p.action.kind === 'ClosePool' || p.action.kind === 'EvictMember')
  const canVote = allowed && !m.isClosing && pending && pool.currentCycle >= p.votingCycle && pool.currentCycle <= p.deadlineCycle
  const status = pending && pool.currentCycle >= p.votingCycle ? 'Open' : p.state
  return { required, passed, cycleCurrent, canFinalize, canExecute, canVote, status }
}
export function votingPower(pool: OnChainPool, member: VotingMember | undefined, action: ProposalAction, creating = false) {
  const m = metrics(pool)
  if (!member || member.pool !== pool.address || member.status !== 'Active') return { eligible: false, reason: 'An active pool membership is required.' }
  if (m.isClosing) return { eligible: false, reason: 'This pool is closing.' }
  if (m.isLocked && action.kind !== 'ClosePool') return { eligible: false, reason: 'Only closure governance is available while locked.' }
  if (!creating && action.kind === 'EvictMember' && (action.member === member.address || action.member === member.wallet)) return { eligible: false, reason: 'The eviction target cannot vote on this proposal.' }
  if (action.kind === 'ClosePool' && m.fundedMemberCount === 0) return { eligible: member.totalContributions > 0n, reason: member.totalContributions > 0n ? 'Contributor closure vote: 1 vote.' : 'Prior contributions are required.' }
  if (!member.isFunded || member.fundedCycle !== pool.currentCycle || member.depositedTotal < pool.memberObligationAmountAtomic) return { eligible: false, reason: 'You must be funded for the current cycle.' }
  if ((creating || action.kind !== 'ClosePool') && m.votingMaturationCycles > 0n && m.votingMemberCount > 0 && !member.isMaturedVoter) return { eligible: false, reason: 'Your funded streak has not matured for voting.' }
  return { eligible: true, reason: '1 member = 1 vote. Streak establishes eligibility, not extra weight.' }
}
function u64(value: bigint, signed = false) {
  if (typeof value !== 'bigint' || value < (signed ? -(1n << 63n) : 0n) || value > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)) throw new Error('Invalid 64-bit integer')
  const b = Buffer.alloc(8); const view = new DataView(b.buffer, b.byteOffset, b.byteLength); if (signed) view.setBigInt64(0, value, true); else view.setBigUint64(0, value, true); return b
}
function keyBytes(value: string) { return new PublicKey(value).toBuffer() }
export function parseUsdc(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('Enter a non-negative USDC amount with at most 6 decimals')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); u64(amount); return amount
}
export function encodeAction(action: ProposalAction): Buffer {
  const tag = proposalKinds.indexOf(action.kind)
  if (tag < 0) throw new Error('Unsupported proposal action')
  let payload: Buffer[] = []
  const mode = (v: ExecutionMode) => { if (!['on_deadline', 'threshold_met'].includes(v)) throw new Error('Invalid execution mode'); return Buffer.from([v === 'threshold_met' ? 1 : 0]) }
  switch (action.kind) {
    case 'SetSpenderLimit': payload = [keyBytes(action.member), u64(action.cap)]; break
    case 'ApproveWithdrawal': payload = [keyBytes(action.request)]; break
    case 'EvictMember': payload = [keyBytes(action.member)]; break
    case 'AdmitMember': payload = [keyBytes(action.candidateWallet), keyBytes(action.vouchedBy)]; break
    case 'ConfigurationModification': {
      if (!Number.isInteger(action.voteThreshold) || action.voteThreshold < 5001 || action.voteThreshold > 10_000) throw new Error('Vote threshold must be 5001–10000 basis points')
      if (action.cycleDurationSeconds <= 0n || action.memberObligationAmount <= 0n || [action.spenderLimitDeadlineCycles, action.withdrawalDeadlineCycles, action.configModificationDeadlineCycles].some(v => v <= 0n)) throw new Error('Configuration durations, obligation and deadlines must be positive')
      const threshold = Buffer.alloc(4); threshold.writeUInt32LE(action.voteThreshold, 0)
      payload = [threshold, u64(action.cycleDurationSeconds, true), u64(action.memberObligationAmount), u64(action.spenderLimitDeadlineCycles), u64(action.withdrawalDeadlineCycles), u64(action.configModificationDeadlineCycles), mode(action.spenderLimitExecutionMode), mode(action.withdrawalExecutionMode), mode(action.configModificationExecutionMode)]; break
    }
  }
  return Buffer.concat([Buffer.from([tag]), ...payload])
}
const instructions = {
  create_proposal: [132,116,68,174,216,160,198,22], vote: [227,110,155,23,136,126,172,25], finalize_proposal: [23,68,51,167,109,173,187,164],
  execute_spender_limit: [22,152,142,129,180,124,223,70], execute_configuration_modification: [66,178,39,67,26,209,95,182],
  execute_close_pool: [132,137,18,177,43,117,143,230], execute_evict_member: [144,68,112,101,164,17,169,56], execute_admit_member: [35,69,67,41,234,236,122,179], spend: [242,205,255,87,101,217,245,57],
}
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export function buildGovernanceTransaction(programId: string, wallet: string, snapshot: GovernanceSnapshot, operation: { kind: 'create'; action: ProposalAction } | { kind: 'vote'; proposal: Proposal; approve: boolean } | { kind: 'finalize' | 'execute'; proposal: Proposal }): Transaction {
  const program = new PublicKey(programId), pool = snapshot.pool, signer = new PublicKey(wallet)
  const pda = (seed: string, ...parts: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], program)[0].toBase58()
  const member = pda('member', keyBytes(pool.address), signer.toBuffer()), global = pda('global'), sys = SystemProgram.programId.toBase58()
  const own = snapshot.members.find(m => m.address === member)
  const account = (address: string, writable = false, isSigner = false): AccountMeta => ({ pubkey: new PublicKey(address), isWritable: writable, isSigner })
  const optional = (address: string | null) => account(address ?? programId, address !== null)
  let name: keyof typeof instructions, keys: AccountMeta[], data = Buffer.alloc(0)
  if (operation.kind === 'create') {
    encodeAction(operation.action)
    const action = operation.action
    if (action.kind === 'EvictMember' && (action.member === member || action.member === wallet)) throw new Error('You cannot propose your own eviction')
    if (action.kind === 'AdmitMember') {
      if (metrics(pool).admissionMode === 'Open') throw new Error('Open pools do not admit members through proposals')
      if (action.vouchedBy !== wallet) throw new Error('The proposer must vouch using their own wallet address')
      if (action.candidateWallet === wallet || action.candidateWallet === SystemProgram.programId.toBase58()) throw new Error('Candidate must be a nonzero wallet different from the proposer')
      if (pool.memberCount >= pool.memberCap) throw new Error('Pool member capacity reached')
    }
    const power = votingPower(pool, own, operation.action, true)
    if (!power.eligible) throw new Error(power.reason)
    if (!proposalEligibility(pool, { pool: pool.address, voteThreshold: pool.voteThreshold, action: operation.action, state: 'Queued', yesVotes: 0, noVotes: 0 } as Proposal, snapshot.now).cycleCurrent) throw new Error('Roll the overdue cycle before creating proposals')
    name = 'create_proposal'; data = encodeAction(operation.action)
    keys = [account(wallet,true,true), account(pool.address,true), account(member), account(pda('proposal',keyBytes(pool.address),u64(pool.nextProposalId)),true), account(sys)]
  } else {
    const p = operation.proposal, eligibility = proposalEligibility(pool, p, snapshot.now)
    if (operation.kind === 'vote') {
      if (typeof operation.approve !== 'boolean') throw new Error('Vote approval must be a boolean')
      const power = votingPower(pool, own, p.action)
      if (!power.eligible) throw new Error(power.reason)
      if (!eligibility.canVote) throw new Error('Proposal is outside its voting window or the cycle requires rollover')
      if (snapshot.receipts.some(r => r.proposal === p.address && r.voter === member)) throw new Error('You have already voted on this proposal')
      name = 'vote'; data = Buffer.from([+operation.approve])
      keys = [account(wallet,true,true),account(pool.address),account(p.address,true),account(member,true),account(pda('vote',keyBytes(p.address),keyBytes(member)),true),account(sys)]
    } else if (operation.kind === 'finalize') {
      if (!eligibility.canFinalize) throw new Error('Proposal cannot be finalized yet')
      name = 'finalize_proposal'; keys = [account(pool.address,true),account(p.address,true)]
    } else {
      if (!eligibility.canExecute) throw new Error('Proposal is not executable or its timelock/cycle delay has not elapsed')
      const a = p.action
      switch (a.kind) {
        case 'SetSpenderLimit': name = 'execute_spender_limit'; keys = [account(wallet,true,true),account(pool.address,true),account(p.address,true),account(a.member,true),account(pda('cycle',keyBytes(pool.address),keyBytes(a.member),u64(pool.currentCycle)),true),account(sys)]; break
        case 'ConfigurationModification': name = 'execute_configuration_modification'; keys = [account(wallet,true,true),account(pool.address,true),account(p.address,true)]; break
        case 'ClosePool': name = 'execute_close_pool'; keys = [account(wallet,false,true),account(global),account(pool.address,true),account(p.address,true),account(pool.vault,true)]; break
        case 'AdmitMember': {
          const inviter = snapshot.members.find(m => m.wallet === a.vouchedBy)
          if (!inviter || inviter.status !== 'Active') throw new Error('Inviter is not an active pool member')
          name = 'execute_admit_member'; keys = [account(wallet,true,true),account(global),account(pool.address,true),account(p.address,true),account(inviter.address,true),account(pda('member',keyBytes(pool.address),keyBytes(a.candidateWallet)),true),account(sys)]; break
        }
        case 'EvictMember': {
          const target = snapshot.members.find(m => m.address === a.member)
          if (!target || target.status !== 'Active') throw new Error('Eviction target is not an active member')
          const prev = snapshot.members.find(m => m.nextMember === a.member)
          if (metrics(pool).headMember !== a.member && !prev) throw new Error('Eviction predecessor missing; refresh pool state')
          name = 'execute_evict_member'; keys = [account(wallet,false,true),account(global),account(pool.address,true),account(p.address,true),account(a.member,true),optional(prev?.address ?? null),account(pool.vault,true),optional(null),account(tokenProgram)]; break
        }
        case 'ApproveWithdrawal': {
          const request = snapshot.withdrawals.find(r => r.address === a.request)
          if (!request || request.status !== 'Pending' || !request.requiresProposal) throw new Error('Withdrawal request is not pending governance approval')
          if (!own || own.status !== 'Active' || !own.isFunded || own.fundedCycle !== pool.currentCycle || own.depositedTotal < pool.memberObligationAmountAtomic) throw new Error('A funded active pool member must execute withdrawals')
          name = 'spend'; keys = [account(wallet,false,true),account(global),account(pool.address,true),account(request.address,true),account(member),account(request.requester,true),optional(null),account(pool.vault,true),account(request.recipient,true),account(tokenProgram),account(p.address,true)]; break
        }
      }
    }
  }
  return new Transaction().add(new TransactionInstruction({ programId: program, keys, data: Buffer.concat([Buffer.from(instructions[name]),data]) }))
}
