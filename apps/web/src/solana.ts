import type { PoolItem } from './data'
import { PublicKey } from '@solana/web3.js'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const POOL_DISCRIMINATOR_BS58 = 'hQrXeCntzbV' // sha256("account:Pool")[..8]

export function toBase58(buffer: Uint8Array): string {
  if (!buffer || buffer.length === 0) {
    throw new Error('Invalid buffer provided to toBase58: expected non-empty Uint8Array.')
  }
  const digits = [0]
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) {
      digits[j] <<= 8
    }
    digits[0] += buffer[i]
    let carry = 0
    for (let j = 0; j < digits.length; ++j) {
      digits[j] += carry
      carry = (digits[j] / 58) | 0
      digits[j] %= 58
    }
    while (carry) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  for (let i = 0; buffer[i] === 0 && i < buffer.length - 1; i++) {
    digits.push(0)
  }
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join('')
}

export type OnChainPool = {
  address: string
  id: number
  creator: string
  vault: string
  memberCap: number
  memberCount: number
  minimumDepositAtomic: bigint
  memberObligationAmountAtomic: bigint
  voteThreshold: number
  votingPeriodSeconds: bigint
  timelockSeconds: bigint
  currentCycle: bigint
  cycleDurationSeconds: bigint
  cycleStartedAt: bigint
  actionAllowancePerCycle: bigint
  maxSponsoredActionCharge: bigint
  nextRequestId: bigint
  nextProposalId: bigint
  testingEnabled: boolean
  hasPendingConfig: boolean
  pendingVoteThreshold: number
  pendingCycleDurationSeconds: bigint
  pendingMemberObligationAmountAtomic: bigint
  spenderLimitDeadlineCycles: bigint
  withdrawalDeadlineCycles: bigint
  configModificationDeadlineCycles: bigint
  pendingSpenderLimitDeadlineCycles: bigint
  pendingWithdrawalDeadlineCycles: bigint
  pendingConfigModificationDeadlineCycles: bigint
  spenderLimitExecutionMode: ExecutionMode
  withdrawalExecutionMode: ExecutionMode
  configModificationExecutionMode: ExecutionMode
  pendingSpenderLimitExecutionMode: ExecutionMode
  pendingWithdrawalExecutionMode: ExecutionMode
  pendingConfigModificationExecutionMode: ExecutionMode
  balanceUsdc: string
  vaultBalanceAtomic: bigint
  metrics: PoolMetrics | null
}

export type PoolMetrics = {
  isClosing: boolean
  totalNonConferredCapital: bigint
  closeDeadlineCycles: bigint
  closeExecutionMode: ExecutionMode
  totalSettledCapital: bigint
  fundedMemberCount: number
  cumulativeBenefitPerMember: bigint
  totalConferredCapital: bigint
  hasSnapshottedClosure: boolean
  closingVaultBasis: bigint
  closingNonConferredBasis: bigint
  closingConferredPoolCapital: bigint
  headMember: string | null
  rolloverCursor: string | null
  isLocked: boolean
  minQuorumMembers: number
  minQuorumBps: number
  lockedConsecutiveCycles: bigint
  autoCloseCyclesThreshold: bigint
  pendingMinQuorumMembers: number
  pendingMinQuorumBps: number
  pendingAutoCloseCyclesThreshold: bigint
  totalEscrowedSurplus: bigint
  evictionDeadlineCycles: bigint
  evictionExecutionMode: ExecutionMode
  pendingEvictionDeadlineCycles: bigint
  pendingEvictionExecutionMode: ExecutionMode
  admissionMode: 'InviteVouched' | 'Open'
  votingMaturationCycles: bigint
  proposalExecutionDelayCycles: bigint
  votingMemberCount: number
  pendingAdmissionMode: 'InviteVouched' | 'Open' | null
  pendingVotingMaturationCycles: bigint | null
  pendingProposalExecutionDelayCycles: bigint | null
}

export type ExecutionMode = 'on_deadline' | 'threshold_met'

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

// Borsh options are variable length: fields after linked-list pointers cannot use fixed offsets.
function decodeMetrics(bytes: Uint8Array): PoolMetrics | null {
  if ([206, 235, 283, 289].includes(bytes.length)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 289
  const take = (size: number) => {
    if (offset + size > bytes.length) throw new Error(`Truncated pool metrics at byte ${offset}`)
    const start = offset
    offset += size
    return start
  }
  const u8 = () => view.getUint8(take(1))
  const u32 = () => view.getUint32(take(4), true)
  const u64 = () => view.getBigUint64(take(8), true)
  const u128 = () => { const low = u64(); return low + (u64() << 64n) }
  const tag = () => { const value = u8(); if (value > 1) throw new Error('Invalid pool boolean or option tag'); return value }
  const bool = () => tag() === 1
  const mode = (): ExecutionMode => tag() === 1 ? 'threshold_met' : 'on_deadline'
  const admission = (): PoolMetrics['admissionMode'] => tag() === 1 ? 'Open' : 'InviteVouched'
  const option = <T,>(read: () => T): T | null => tag() === 1 ? read() : null
  const pubkey = () => toBase58(bytes.subarray(take(32), offset))
  return {
    isClosing: bool(), totalNonConferredCapital: u64(), closeDeadlineCycles: u64(), closeExecutionMode: mode(),
    totalSettledCapital: u64(), fundedMemberCount: u32(), cumulativeBenefitPerMember: u128(),
    totalConferredCapital: u64(), hasSnapshottedClosure: bool(), closingVaultBasis: u64(),
    closingNonConferredBasis: u64(), closingConferredPoolCapital: u64(),
    headMember: option(pubkey), rolloverCursor: option(pubkey), isLocked: bool(),
    minQuorumMembers: u32(), minQuorumBps: u32(), lockedConsecutiveCycles: u64(), autoCloseCyclesThreshold: u64(),
    pendingMinQuorumMembers: u32(), pendingMinQuorumBps: u32(), pendingAutoCloseCyclesThreshold: u64(),
    totalEscrowedSurplus: u64(), evictionDeadlineCycles: u64(), evictionExecutionMode: mode(),
    pendingEvictionDeadlineCycles: u64(), pendingEvictionExecutionMode: mode(), admissionMode: admission(),
    votingMaturationCycles: u64(), proposalExecutionDelayCycles: u64(), votingMemberCount: u32(),
    pendingAdmissionMode: option(admission), pendingVotingMaturationCycles: option(u64),
    pendingProposalExecutionDelayCycles: option(u64),
  }
}

export function decodePoolAccountData(address: string, dataBytes: Uint8Array): Omit<OnChainPool, 'balanceUsdc' | 'vaultBalanceAtomic'> {
  if (dataBytes.length < 206) {
    throw new Error(`Invalid pool account data length: ${dataBytes.length} bytes (expected at least 206 bytes)`)
  }

  new PublicKey(address)
  if (toBase58(dataBytes.subarray(0, 8)) !== POOL_DISCRIMINATOR_BS58) throw new Error('Invalid Pool account discriminator')
  if (dataBytes.length < 289 && ![206, 235, 283].includes(dataBytes.length)) throw new Error('Unsupported or truncated pool account layout')

  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength)

  // Skip 8-byte Anchor account discriminator
  const idBig = view.getBigUint64(40, true)
  const creator = toBase58(dataBytes.subarray(48, 80))
  const vault = toBase58(dataBytes.subarray(80, 112))
  const memberCap = view.getUint32(112, true)
  const memberCount = view.getUint32(116, true)
  const minimumDepositAtomic = view.getBigUint64(120, true)

  // Backward-compatible decode if an older 206-byte pool exists
  const isNewLayout = dataBytes.length >= 235
  const isDeadlineCyclesLayout = dataBytes.length >= 283
  const isExecutionModeLayout = dataBytes.length >= 289
  const parseModeByte = (byte: number): ExecutionMode => {
    if (byte > 1) throw new Error('Invalid pool execution mode')
    return byte === 1 ? 'threshold_met' : 'on_deadline'
  }
  const spenderLimitExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(283)) : 'on_deadline'
  const withdrawalExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(284)) : 'on_deadline'
  const configModificationExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(285)) : 'on_deadline'
  const pendingSpenderLimitExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(286)) : spenderLimitExecutionMode
  const pendingWithdrawalExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(287)) : withdrawalExecutionMode
  const pendingConfigModificationExecutionMode = isExecutionModeLayout ? parseModeByte(view.getUint8(288)) : configModificationExecutionMode
  const memberObligationAmountAtomic = isNewLayout ? view.getBigUint64(128, true) : minimumDepositAtomic
  const voteThreshold = isNewLayout ? view.getUint32(136, true) : view.getUint32(128, true)
  const votingPeriodSeconds = isNewLayout ? view.getBigInt64(140, true) : view.getBigInt64(132, true)
  const timelockSeconds = isNewLayout ? view.getBigInt64(148, true) : view.getBigInt64(140, true)
  const currentCycle = isNewLayout ? view.getBigUint64(156, true) : view.getBigUint64(148, true)
  const cycleDurationSeconds = isNewLayout ? view.getBigInt64(164, true) : view.getBigInt64(156, true)
  const cycleStartedAt = isNewLayout ? view.getBigInt64(172, true) : view.getBigInt64(164, true)
  const actionAllowancePerCycle = isNewLayout ? view.getBigUint64(180, true) : view.getBigUint64(172, true)
  const maxSponsoredActionCharge = isNewLayout ? view.getBigUint64(188, true) : view.getBigUint64(180, true)
  const nextRequestId = isNewLayout ? view.getBigUint64(196, true) : view.getBigUint64(188, true)
  const nextProposalId = isNewLayout ? view.getBigUint64(204, true) : view.getBigUint64(196, true)
  const testingEnabled = isNewLayout ? view.getUint8(213) === 1 : (dataBytes.length >= 206 ? view.getUint8(205) === 1 : false)
  const hasPendingConfig = isNewLayout ? view.getUint8(214) === 1 : false
  const pendingVoteThreshold = isNewLayout ? view.getUint32(215, true) : voteThreshold
  const pendingCycleDurationSeconds = isNewLayout ? view.getBigInt64(219, true) : cycleDurationSeconds
  const pendingMemberObligationAmountAtomic = isNewLayout ? view.getBigUint64(227, true) : memberObligationAmountAtomic
  const spenderLimitDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(235, true) : 1n
  const withdrawalDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(243, true) : 1n
  const configModificationDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(251, true) : 1n
  const pendingSpenderLimitDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(259, true) : spenderLimitDeadlineCycles
  const pendingWithdrawalDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(267, true) : withdrawalDeadlineCycles
  const pendingConfigModificationDeadlineCycles = isDeadlineCyclesLayout ? view.getBigUint64(275, true) : configModificationDeadlineCycles

  const metrics = decodeMetrics(dataBytes)
  if (metrics) quorumHealth(metrics, memberCount)
  if (idBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pool ID exceeds safe integer range')
  return {
    metrics,
    address,
    id: Number(idBig),
    creator,
    vault,
    memberCap,
    memberCount,
    minimumDepositAtomic,
    memberObligationAmountAtomic,
    voteThreshold,
    votingPeriodSeconds,
    timelockSeconds,
    currentCycle,
    cycleDurationSeconds,
    cycleStartedAt,
    actionAllowancePerCycle,
    maxSponsoredActionCharge,
    nextRequestId,
    nextProposalId,
    testingEnabled,
    hasPendingConfig,
    pendingVoteThreshold,
    pendingCycleDurationSeconds,
    pendingMemberObligationAmountAtomic,
    spenderLimitDeadlineCycles,
    withdrawalDeadlineCycles,
    configModificationDeadlineCycles,
    pendingSpenderLimitDeadlineCycles,
    pendingWithdrawalDeadlineCycles,
    pendingConfigModificationDeadlineCycles,
    spenderLimitExecutionMode,
    withdrawalExecutionMode,
    configModificationExecutionMode,
    pendingSpenderLimitExecutionMode,
    pendingWithdrawalExecutionMode,
    pendingConfigModificationExecutionMode,
  }
}

export async function fetchVaultBalanceAtomic(rpcUrl: string, vaultPubkey: string): Promise<bigint> {
  if (!rpcUrl) throw new Error('Missing rpcUrl in fetchVaultBalance')
  if (!vaultPubkey) throw new Error('Missing vaultPubkey in fetchVaultBalance')

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'getTokenAccountBalance',
      params: [vaultPubkey],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error ${response.status} fetching vault balance`)
  }

  const json = await response.json() as { result?: { value?: { uiAmountString?: string; amount?: string } }; error?: { message: string } }
  if (json.error) {
    throw new Error(`Solana RPC error fetching vault balance for ${vaultPubkey}: ${json.error.message}`)
  }

  const amount = json.result?.value?.amount
  if (amount == null || !/^\d+$/.test(amount)) throw new Error('Invalid or missing vault token amount')
  return BigInt(amount)
}

export function formatUsdc(atomic: bigint): string {
  if (typeof atomic !== 'bigint' || atomic < 0n) throw new Error('Invalid USDC atomic amount')
  // Round to cents without converting u64 values to floating point.
  const cents = (atomic + 5_000n) / 10_000n
  return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`
}

export async function fetchVaultBalance(rpcUrl: string, vaultPubkey: string): Promise<string> {
  return formatUsdc(await fetchVaultBalanceAtomic(rpcUrl, vaultPubkey))
}

export function poolFromAccount(address: string, base64: string, vaultBalanceAtomic: string): OnChainPool {
  if (!base64) throw new Error('Missing pool account data')
  if (!/^\d+$/.test(vaultBalanceAtomic)) throw new Error('Invalid vault atomic amount')
  const pool = decodePoolAccountData(address, base64ToUint8Array(base64))
  const balance = BigInt(vaultBalanceAtomic)
  return { ...pool, vaultBalanceAtomic: balance, balanceUsdc: formatUsdc(balance) }
}

export async function fetchOnChainPools(rpcUrl: string, programId: string): Promise<OnChainPool[]> {
  if (!rpcUrl) throw new Error('Missing required argument: rpcUrl')
  if (!programId) throw new Error('Missing required argument: programId')

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        programId,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_BS58 } }],
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC returned status ${response.status} when querying program accounts`)
  }

  const json = await response.json() as {
    result?: Array<{ pubkey: string; account: { data: [string, string] } }>
    error?: { message: string }
  }

  if (json.error) {
    throw new Error(`Solana RPC error: ${json.error.message}`)
  }

  if (!Array.isArray(json.result)) throw new Error('Invalid or missing program accounts result')
  const rawList = json.result
  const poolsWithoutBalance = rawList.map(item => {
    const rawBytes = base64ToUint8Array(item.account.data[0])
    return decodePoolAccountData(item.pubkey, rawBytes)
  })

  // Sort by pool ID ascending
  poolsWithoutBalance.sort((a, b) => a.id - b.id)

  // Fetch balances in parallel
  const pools: OnChainPool[] = await Promise.all(
    poolsWithoutBalance.map(async pool => {
      const vaultBalanceAtomic = await fetchVaultBalanceAtomic(rpcUrl, pool.vault)
      return { ...pool, vaultBalanceAtomic, balanceUsdc: formatUsdc(vaultBalanceAtomic) }
    })
  )

  return pools
}

export function quorumHealth(metrics: PoolMetrics, memberCount: number) {
  if (!metrics || ![memberCount, metrics.fundedMemberCount, metrics.votingMemberCount, metrics.minQuorumMembers, metrics.minQuorumBps]
    .every(value => Number.isSafeInteger(value) && value >= 0)
    || metrics.fundedMemberCount > memberCount || metrics.votingMemberCount > memberCount || metrics.minQuorumBps > 10_000
    || typeof metrics.lockedConsecutiveCycles !== 'bigint' || metrics.lockedConsecutiveCycles < 0n
    || typeof metrics.autoCloseCyclesThreshold !== 'bigint' || metrics.autoCloseCyclesThreshold < 0n) {
    throw new Error('Invalid quorum member counts or basis points')
  }
  const participationBps = Math.floor(metrics.fundedMemberCount * 10_000 / Math.max(memberCount, 1))
  return {
    participationBps,
    satisfied: metrics.fundedMemberCount >= metrics.minQuorumMembers && participationBps >= metrics.minQuorumBps,
    cyclesUntilAutoClose: metrics.autoCloseCyclesThreshold === 0n ? null :
      (metrics.autoCloseCyclesThreshold > metrics.lockedConsecutiveCycles ? metrics.autoCloseCyclesThreshold - metrics.lockedConsecutiveCycles : 0n),
  }
}

const ICONS = ['✦', '♣', '☻', '★', '◆', '✺']
const ACCENTS = ['coral', 'lime', 'sky', 'violet']

export function onChainPoolToPoolItem(pool: OnChainPool, currentWalletPubkey?: string): PoolItem {
  const isCreator = currentWalletPubkey && pool.creator === currentWalletPubkey
  const icon = ICONS[pool.id % ICONS.length]
  const accent = ACCENTS[pool.id % ACCENTS.length]
  const formattedMinDeposit = formatUsdc(pool.minimumDepositAtomic)

  return {
    id: `pool-${pool.id}`,
    icon,
    accent,
    name: `Community Pool #${pool.id}`,
    role: isCreator ? 'Creator' : 'Membership not loaded',
    status: `${pool.metrics?.isClosing ? 'Closing' : pool.metrics?.isLocked ? 'Locked' : pool.metrics ? 'Active' : 'Status unavailable'} · Cycle ${pool.currentCycle.toString()}`,
    balance: pool.balanceUsdc,
    funds: `${pool.memberCount} of ${pool.memberCap}`,
    nextDate: pool.metrics?.isClosing ? 'Pool closing' : new Date(Number(pool.cycleStartedAt + pool.cycleDurationSeconds) * 1000).toLocaleString(),
    proposals: Number(pool.nextProposalId),
    requests: Number(pool.nextRequestId),
    cap: pool.memberCap,
    slots: pool.memberCap - pool.memberCount,
    address: pool.address,
    vault: pool.vault,
    creator: pool.creator,
    onChain: true,
    minimumDeposit: formattedMinDeposit,
    voteThreshold: pool.voteThreshold,
    votingPeriodSeconds: Number(pool.votingPeriodSeconds),
    timelockSeconds: Number(pool.timelockSeconds),
    currentCycle: Number(pool.currentCycle),
    cycleStartedAt: Number(pool.cycleStartedAt),
    chain: pool,
    cycleDurationSeconds: Number(pool.cycleDurationSeconds),
    memberObligationAmount: pool.memberObligationAmountAtomic ? `$${(Number(pool.memberObligationAmountAtomic) / 1e6).toFixed(2)}` : undefined,
    admissionMode: (pool as any).admissionMode ?? 'InviteVouched',
  }
}
