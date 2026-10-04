import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as anchor from '@coral-xyz/anchor'
import BN from 'bn.js'
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { canonicalQuote, HmacSha256QuoteSigner, InMemorySponsorPolicyRepository, SponsorQuoteService } from '@comfi/sponsor-api'
import type { ExecutionMode, GlobalConfigInfo, MemberInfo, PoolInfo, ProposalInfo, SponsorQuoteResult, SystemStatus, WalletInfo, WithdrawalRequestInfo } from '../types.js'

export function parseExecutionMode(mode: any): ExecutionMode {
  if (!mode) return 'on_deadline'
  if (typeof mode === 'string') {
    return mode === 'threshold_met' || mode === 'ThresholdMet' ? 'threshold_met' : 'on_deadline'
  }
  if (mode.thresholdMet) return 'threshold_met'
  return 'on_deadline'
}

export function toExecutionModeArg(mode?: string): { onDeadline: {} } | { thresholdMet: {} } {
  if (mode === 'threshold_met' || mode === 'ThresholdMet') {
    return { thresholdMet: {} }
  }
  return { onDeadline: {} }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const rpcUrl = process.env.VITE_SOLANA_RPC ?? process.env.COMFI_LOCALNET_RPC ?? 'http://127.0.0.1:8899'
const programId = new PublicKey('3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP')
const localnetDirectory = resolve(root, '.localnet')
const usdcDecimals = 6
const oneUsdc = 10n ** BigInt(usdcDecimals)

const connection = new Connection(rpcUrl, 'confirmed')

async function readJsonFile(path: string): Promise<any> {
  const content = await readFile(path, 'utf8')
  return JSON.parse(content)
}

async function loadKeypair(name: string, fallbackSeed?: Uint8Array): Promise<Keypair> {
  const path = resolve(localnetDirectory, `${name}.json`)
  try {
    const raw = await readJsonFile(path)
    return Keypair.fromSecretKey(Uint8Array.from(raw))
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    const next = fallbackSeed ? Keypair.fromSeed(fallbackSeed) : Keypair.generate()
    await mkdir(localnetDirectory, { recursive: true })
    await writeFile(path, JSON.stringify(Array.from(next.secretKey)), 'utf8')
    return next
  }
}

export async function getLocalWallets(): Promise<{
  administrator: Keypair
  creator: Keypair
  member2: Keypair
  quoteAuthority: Keypair
}> {
  const administrator = await loadKeypair('administrator')
  const creator = await loadKeypair('creator', Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7)).secretKey.slice(0, 32))
  const member2 = await loadKeypair('member2', Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 42)).secretKey.slice(0, 32))
  const quoteAuthority = await loadKeypair('quote-authority')
  return { administrator, creator, member2, quoteAuthority }
}

async function getProgram(): Promise<any> {
  const idlPath = resolve(root, 'target/idl/comfi.json')
  const idl = await readJsonFile(idlPath)
  const wallets = await getLocalWallets()
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallets.administrator), { commitment: 'confirmed' })
  return new anchor.Program(idl, provider)
}

export function formatUsdc(atomic: bigint | number | string): string {
  const bi = BigInt(atomic)
  const val = Number(bi) / 1e6
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const program = await getProgram()
  const wallets = await getLocalWallets()
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId)
  
  const slot = await connection.getSlot('confirmed')
  const globalAccount = await program.account.globalConfig.fetchNullable(globalPda) as any

  let globalInfo: GlobalConfigInfo
  if (!globalAccount) {
    globalInfo = {
      initialized: false,
      address: globalPda.toBase58(),
      usdcMint: '',
      treasuryUsdc: '',
      quoteAuthority: '',
      nextPoolId: 0,
      pausedNewPools: false,
    }
  } else {
    globalInfo = {
      initialized: true,
      address: globalPda.toBase58(),
      usdcMint: globalAccount.usdcMint.toBase58(),
      treasuryUsdc: globalAccount.treasuryUsdc.toBase58(),
      quoteAuthority: globalAccount.quoteAuthority.toBase58(),
      nextPoolId: Number(globalAccount.nextPoolId),
      pausedNewPools: Boolean(globalAccount.pausedNewPools),
    }
  }

  const walletKeys: Array<{ name: WalletInfo['name']; label: string; kp: Keypair }> = [
    { name: 'administrator', label: 'Administrator', kp: wallets.administrator },
    { name: 'creator', label: 'Demo Creator / Member 1', kp: wallets.creator },
    { name: 'member2', label: 'Test Member 2', kp: wallets.member2 },
    { name: 'quote-authority', label: 'Quote Authority', kp: wallets.quoteAuthority },
  ]

  const walletsMap: Record<string, WalletInfo> = {}
  for (const { name, label, kp } of walletKeys) {
    const lamports = await connection.getBalance(kp.publicKey)
    const solBalance = `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    let usdcAta = ''
    let usdcBalance = '$0.00'

    if (globalInfo.initialized && globalInfo.usdcMint) {
      const mintPubkey = new PublicKey(globalInfo.usdcMint)
      const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      const [ata] = PublicKey.findProgramAddressSync([kp.publicKey.toBuffer(), tokenProgram.toBuffer(), mintPubkey.toBuffer()], associatedTokenProgram)
      usdcAta = ata.toBase58()

      const ataInfo = await connection.getAccountInfo(ata)
      if (ataInfo) {
        const bal = await connection.getTokenAccountBalance(ata)
        usdcBalance = `$${Number(bal.value.uiAmountString ?? '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      }
    }

    walletsMap[name] = {
      name,
      label,
      publicKey: kp.publicKey.toBase58(),
      solBalance,
      usdcAta,
      usdcBalance,
    }
  }

  // Fetch pools
  const poolAccounts = await program.account.pool.all()
  const pools: PoolInfo[] = await Promise.all(
    poolAccounts.map(async (item: any) => {
      const p = item.account
      let vaultUsdcBalance = '$0.00'
      const vaultInfo = await connection.getAccountInfo(p.vault)
      if (vaultInfo) {
        const bal = await connection.getTokenAccountBalance(p.vault)
        vaultUsdcBalance = `$${Number(bal.value.uiAmountString ?? '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      }

      return {
        address: item.publicKey.toBase58(),
        id: Number(p.id),
        creator: p.creator.toBase58(),
        vault: p.vault.toBase58(),
        vaultUsdcBalance,
        memberCap: Number(p.memberCap),
        memberCount: Number(p.memberCount),
        minimumDeposit: formatUsdc(p.minimumDeposit.toString()),
        memberObligationAmount: formatUsdc((p.memberObligationAmount ?? p.minimumDeposit).toString()),
        voteThreshold: Number(p.voteThreshold),
        votingPeriodSeconds: Number(p.votingPeriodSeconds),
        timelockSeconds: Number(p.timelockSeconds),
        currentCycle: Number(p.currentCycle),
        cycleDurationSeconds: Number(p.cycleDurationSeconds),
        cycleStartedAt: Number(p.cycleStartedAt),
        actionAllowancePerCycle: formatUsdc(p.actionAllowancePerCycle.toString()),
        maxSponsoredActionCharge: formatUsdc(p.maxSponsoredActionCharge.toString()),
        nextRequestId: Number(p.nextRequestId),
        nextProposalId: Number(p.nextProposalId),
        testingEnabled: Boolean(p.testingEnabled),
        hasPendingConfig: Boolean(p.hasPendingConfig),
        pendingVoteThreshold: Number(p.pendingVoteThreshold ?? p.voteThreshold),
        pendingCycleDurationSeconds: Number(p.pendingCycleDurationSeconds ?? p.cycleDurationSeconds),
        pendingMemberObligationAmount: formatUsdc((p.pendingMemberObligationAmount ?? p.memberObligationAmount ?? p.minimumDeposit).toString()),
        spenderLimitDeadlineCycles: Number(p.spenderLimitDeadlineCycles ?? 1),
        withdrawalDeadlineCycles: Number(p.withdrawalDeadlineCycles ?? 1),
        pendingSpenderLimitDeadlineCycles: Number(p.pendingSpenderLimitDeadlineCycles ?? p.spenderLimitDeadlineCycles ?? 1),
        pendingWithdrawalDeadlineCycles: Number(p.pendingWithdrawalDeadlineCycles ?? p.withdrawalDeadlineCycles ?? 1),
        pendingConfigModificationDeadlineCycles: Number(p.pendingConfigModificationDeadlineCycles ?? p.configModificationDeadlineCycles ?? 1),
        spenderLimitExecutionMode: parseExecutionMode(p.spenderLimitExecutionMode),
        withdrawalExecutionMode: parseExecutionMode(p.withdrawalExecutionMode),
        configModificationExecutionMode: parseExecutionMode(p.configModificationExecutionMode),
        pendingSpenderLimitExecutionMode: parseExecutionMode(p.pendingSpenderLimitExecutionMode ?? p.spenderLimitExecutionMode),
        pendingWithdrawalExecutionMode: parseExecutionMode(p.pendingWithdrawalExecutionMode ?? p.withdrawalExecutionMode),
        pendingConfigModificationExecutionMode: parseExecutionMode(p.pendingConfigModificationExecutionMode ?? p.configModificationExecutionMode),
        isClosing: Boolean(p.isClosing),
        isLocked: Boolean(p.isLocked),
        admissionMode: p.admissionMode?.open || p.admissionMode === 'Open' || p.admissionMode === 'open' ? 'Open' : 'InviteVouched',
        fundedMemberCount: Number(p.fundedMemberCount ?? 0),
        votingMemberCount: Number(p.votingMemberCount ?? 0),
        minQuorumMembers: Number(p.minQuorumMembers ?? 0),
        minQuorumBps: Number(p.minQuorumBps ?? 0),
        autoCloseCyclesThreshold: Number(p.autoCloseCyclesThreshold ?? 0),
        totalConferredCapital: formatUsdc(p.totalConferredCapital ? p.totalConferredCapital.toString() : 0),
        totalNonConferredCapital: formatUsdc(p.totalNonConferredCapital ? p.totalNonConferredCapital.toString() : 0),
        totalEscrowedSurplus: formatUsdc(p.totalEscrowedSurplus ? p.totalEscrowedSurplus.toString() : 0),
        lockedConsecutiveCycles: Number(p.lockedConsecutiveCycles ?? 0),
      }
    })
  )

  pools.sort((a, b) => a.id - b.id)

  return {
    connected: true,
    rpcUrl,
    programId: programId.toBase58(),
    slot,
    global: globalInfo,
    wallets: walletsMap,
    pools,
  }
}

export async function getPoolDetails(poolAddress: string): Promise<{
  members: MemberInfo[]
  proposals: ProposalInfo[]
  requests: WithdrawalRequestInfo[]
}> {
  if (!poolAddress) throw new Error('poolAddress is required')
  const poolPubkey = new PublicKey(poolAddress)
  const program = await getProgram()

  const poolAccount = await program.account.pool.fetch(poolPubkey)
  const currentCycle = new BN(poolAccount.currentCycle.toString())

  // Fetch members for this pool
  const memberAccounts = await program.account.member.all([
    { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
  ])
  const members: MemberInfo[] = await Promise.all(
    memberAccounts.map(async (item: any) => {
      const m = item.account
      const [spenderCyclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('cycle'), poolPubkey.toBuffer(), item.publicKey.toBuffer(), currentCycle.toArrayLike(Buffer, 'le', 8)],
        programId
      )
      const cycleAccount = (await program.account.spenderCycle.fetchNullable(spenderCyclePda)) as any
      const spendLimit = cycleAccount ? formatUsdc(cycleAccount.cap.toString()) : '$0.00'
      const spentCurrentCycle = cycleAccount ? formatUsdc(cycleAccount.spent.toString()) : '$0.00'

      let status: MemberInfo['status'] = 'Active'
      if (m.status?.leaving || m.status === 'Leaving') status = 'Leaving'
      else if (m.status?.exited || m.status === 'Exited') status = 'Exited'
      else if (m.status?.evicted || m.status === 'Evicted') status = 'Evicted'

      return {
        address: item.publicKey.toBase58(),
        pool: m.pool.toBase58(),
        wallet: m.wallet.toBase58(),
        role: m.role.admin ? 'Admin' : m.role.spender ? 'Spender' : 'Member',
        isFunded: Boolean(m.isFunded),
        depositedTotal: formatUsdc(m.depositedTotal.toString()),
        aliasHashHex: Buffer.from(m.aliasHash).toString('hex'),
        encryptionPubKeyHex: Buffer.from(m.encryptionPublicKey).toString('hex'),
        aliasVersion: Number(m.aliasVersion),
        allowanceCycle: Number(m.allowanceCycle),
        actionAllowanceUsed: formatUsdc(m.actionAllowanceUsed.toString()),
        spendLimit,
        spentCurrentCycle,
        isPaused: Boolean(m.isPaused),
        status,
        surplusAmount: formatUsdc(m.surplusAmount ? m.surplusAmount.toString() : 0),
        claimableSurplusEscrow: formatUsdc(m.claimableSurplusEscrow ? m.claimableSurplusEscrow.toString() : 0),
        lineageDepth: Number(m.lineageDepth ?? 0),
        vouchedBy: m.vouchedBy ? m.vouchedBy.toBase58() : null,
        isMaturedVoter: Boolean(m.isMaturedVoter),
        vouchedCount: Number(m.vouchedCount ?? 0),
        streak: Number(m.fundedCycleStreak ?? 0),
      }
    })
  )

  // Fetch proposals for this pool
  const proposalAccounts = await program.account.proposal.all([
    { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
  ])
  const proposals: ProposalInfo[] = proposalAccounts.map((item: any) => {
    const p = item.account
    let actionType: ProposalInfo['actionType'] = 'Other'
    let actionDetails = ''
    let targetMember: string | undefined
    let candidateWallet: string | undefined
    let vouchedBy: string | undefined

    if (p.action.setSpenderLimit) {
      actionType = 'SetSpenderLimit'
      const mStr = p.action.setSpenderLimit.member.toBase58()
      targetMember = mStr
      actionDetails = `Member: ${mStr.slice(0, 8)}… Cap: ${formatUsdc(p.action.setSpenderLimit.cap.toString())}`
    } else if (p.action.approveWithdrawal) {
      actionType = 'ApproveWithdrawal'
      actionDetails = `Request: ${p.action.approveWithdrawal.request.toBase58().slice(0, 8)}…`
    } else if (p.action.configurationModification) {
      actionType = 'ConfigurationModification'
      const cfg = p.action.configurationModification
      actionDetails = `Threshold: ${cfg.voteThreshold}, Cycle: ${cfg.cycleDurationSeconds.toString()}s, Obligation: ${formatUsdc(cfg.memberObligationAmount.toString())}, Deadlines: Spender=${cfg.spenderLimitDeadlineCycles ?? 1}c (${parseExecutionMode(cfg.spenderLimitExecutionMode)}), Withdrawal=${cfg.withdrawalDeadlineCycles ?? 1}c (${parseExecutionMode(cfg.withdrawalExecutionMode)}), Config=${cfg.configModificationDeadlineCycles ?? 1}c (${parseExecutionMode(cfg.configModificationExecutionMode)})`
    } else if (p.action.closePool) {
      actionType = 'ClosePool'
      actionDetails = 'Initiates pool closure and capital snapshot'
    } else if (p.action.evictMember) {
      actionType = 'EvictMember'
      const mStr = p.action.evictMember.member.toBase58()
      targetMember = mStr
      actionDetails = `Target Member: ${mStr.slice(0, 8)}…`
    } else if (p.action.admitMember) {
      actionType = 'AdmitMember'
      const cStr = p.action.admitMember.candidateWallet.toBase58()
      const vStr = p.action.admitMember.vouchedBy.toBase58()
      candidateWallet = cStr
      vouchedBy = vStr
      actionDetails = `Candidate: ${cStr.slice(0, 8)}…, Vouched by: ${vStr.slice(0, 8)}…`
    }

    let state: ProposalInfo['state'] = 'Open'
    if (p.state.queued) state = 'Queued'
    else if (p.state.open) state = 'Open'
    else if (p.state.executable) state = 'Executable'
    else if (p.state.executed) state = 'Executed'
    else if (p.state.rejected) state = 'Rejected'

    return {
      address: item.publicKey.toBase58(),
      pool: p.pool.toBase58(),
      id: Number(p.id),
      proposer: p.proposer.toBase58(),
      actionType,
      actionDetails,
      targetMember,
      candidateWallet,
      vouchedBy,
      yesVotes: Number(p.yesVotes),
      noVotes: Number(p.noVotes),
      votingCycle: Number(p.votingCycle ?? 0),
      deadlineCycle: Number(p.deadlineCycle ?? p.votingCycle ?? 0),
      deadline: Number(p.deadline),
      executableAfter: Number(p.executableAfter),
      state,
      executionMode: parseExecutionMode(p.executionMode),
      voteThreshold: Number(p.voteThreshold ?? poolAccount.voteThreshold ?? 1),
    }
  })

  proposals.sort((a, b) => a.id - b.id)

  // Fetch withdrawal requests for this pool
  const requestAccounts = await program.account.withdrawalRequest.all([
    { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
  ])
  const requests: WithdrawalRequestInfo[] = requestAccounts.map((item: any) => {
    const r = item.account
    let status: WithdrawalRequestInfo['status'] = 'Pending'
    if (r.status.spent) status = 'Spent'
    else if (r.status.cancelled) status = 'Cancelled'

    return {
      address: item.publicKey.toBase58(),
      pool: r.pool.toBase58(),
      id: Number(r.id),
      requester: r.requester.toBase58(),
      recipient: r.recipient.toBase58(),
      amount: formatUsdc(r.amount.toString()),
      justificationHashHex: Buffer.from(r.justificationHash).toString('hex'),
      requiresProposal: Boolean(r.requiresProposal),
      status,
    }
  })
  requests.sort((a, b) => a.id - b.id)

  return { members, proposals, requests }
}

export async function executeAction(action: string, payload: any): Promise<any> {
  const wallets = await getLocalWallets()
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId)

  switch (action) {
    case 'initialize_global': {
      const program = await getProgram()
      let globalAccount = await program.account.globalConfig.fetchNullable(globalPda)
      if (globalAccount) {
        throw new Error('GlobalConfig has already been initialized.')
      }

      // Ensure administrator has SOL
      const adminBal = await connection.getBalance(wallets.administrator.publicKey)
      if (adminBal < LAMPORTS_PER_SOL) {
        const sig = await connection.requestAirdrop(wallets.administrator.publicKey, 2 * LAMPORTS_PER_SOL)
        await connection.confirmTransaction(sig, 'confirmed')
      }

      const mint = await createMint(connection, wallets.administrator, wallets.administrator.publicKey, null, usdcDecimals)
      const treasury = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, wallets.administrator.publicKey)

      const tx = await program.methods
        .initializeGlobalConfig(wallets.quoteAuthority.publicKey)
        .accounts({
          administrator: wallets.administrator.publicKey,
          usdcMint: mint,
          treasuryUsdc: treasury.address,
          global: globalPda,
        })
        .signers([wallets.administrator])
        .rpc()

      return { tx, global: globalPda.toBase58(), mint: mint.toBase58(), treasury: treasury.address.toBase58() }
    }

    case 'toggle_pause_new_pools': {
      const program = await getProgram()
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const currentPaused = Boolean(globalAccount.pausedNewPools)
      const nextPaused = payload.paused ?? !currentPaused

      const tx = await program.methods
        .pauseNewPoolCreation(nextPaused)
        .accounts({
          administrator: wallets.administrator.publicKey,
          global: globalPda,
        })
        .signers([wallets.administrator])
        .rpc()

      return { tx, paused: nextPaused }
    }

    case 'fund_wallet': {
      const { walletName, solAmount = 2, usdcAmount = 500 } = payload
      if (!walletName || !wallets[walletName as keyof typeof wallets]) {
        throw new Error(`Invalid wallet name: ${walletName}`)
      }
      const targetWallet = wallets[walletName as keyof typeof wallets]
      const program = await getProgram()
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      // Airdrop SOL
      if (solAmount > 0) {
        const sig = await connection.requestAirdrop(targetWallet.publicKey, solAmount * LAMPORTS_PER_SOL)
        await connection.confirmTransaction(sig, 'confirmed')
      }

      // Mint USDC
      let ataAddress = ''
      if (usdcAmount > 0) {
        const ata = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, targetWallet.publicKey)
        ataAddress = ata.address.toBase58()
        const amountAtomic = BigInt(Math.floor(usdcAmount * 1e6))
        await mintTo(connection, wallets.administrator, mint, ata.address, wallets.administrator, amountAtomic)
      }

      return { wallet: targetWallet.publicKey.toBase58(), solAmount, usdcAmount, ataAddress }
    }

    case 'create_pool': {
      const {
        memberCap = 24,
        minimumDeposit = 10,
        memberObligationAmount = payload.memberObligationAmount ?? minimumDeposit ?? 10,
        initialDeposit = 100,
        enrollmentFee = 1,
        voteThreshold = 5001,
        votingPeriodSeconds = 604800,
        timelockSeconds = 86400,
        cycleDurationSeconds = 2592000,
        actionAllowancePerCycle = 5,
        maxSponsoredActionCharge = 1,
      } = payload

      const program = await getProgram()
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint
      const treasuryUsdc = globalAccount.treasuryUsdc
      const nextPoolId = new BN(globalAccount.nextPoolId.toString())

      const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from('pool'), nextPoolId.toArrayLike(Buffer, 'le', 8)], programId)
      const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      const [vaultPda] = PublicKey.findProgramAddressSync([poolPda.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram)
      const [creatorMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPda.toBuffer(), wallets.creator.publicKey.toBuffer()], programId)

      // Ensure creator has SOL and USDC
      const creatorBal = await connection.getBalance(wallets.creator.publicKey)
      if (creatorBal < LAMPORTS_PER_SOL) {
        const sig = await connection.requestAirdrop(wallets.creator.publicKey, 2 * LAMPORTS_PER_SOL)
        await connection.confirmTransaction(sig, 'confirmed')
      }
      const creatorUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, wallets.creator.publicKey)
      const creatorUsdcBal = await getAccount(connection, creatorUsdcAta.address)
      const neededAtomic = BigInt(Math.floor((initialDeposit + enrollmentFee) * 1e6))
      if (creatorUsdcBal.amount < neededAtomic) {
        await mintTo(connection, wallets.administrator, mint, creatorUsdcAta.address, wallets.administrator, neededAtomic + 1000n * oneUsdc)
      }

      const tx = await program.methods
        .createPool({
          memberCap,
          minimumDeposit: new BN(BigInt(Math.floor(minimumDeposit * 1e6)).toString()),
          memberObligationAmount: new BN(BigInt(Math.floor(memberObligationAmount * 1e6)).toString()),
          initialDeposit: new BN(BigInt(Math.floor(initialDeposit * 1e6)).toString()),
          enrollmentFee: new BN(BigInt(Math.floor(enrollmentFee * 1e6)).toString()),
          voteThreshold,
          votingPeriodSeconds: new BN(votingPeriodSeconds),
          timelockSeconds: new BN(timelockSeconds),
          cycleDurationSeconds: new BN(cycleDurationSeconds),
          actionAllowancePerCycle: new BN(BigInt(Math.floor(actionAllowancePerCycle * 1e6)).toString()),
          maxSponsoredActionCharge: new BN(BigInt(Math.floor(maxSponsoredActionCharge * 1e6)).toString()),
          creatorAliasHash: Array(32).fill(0),
          creatorEncryptionPublicKey: Array(32).fill(0),
          testingEnabled: payload.testingEnabled ?? true,
          spenderLimitDeadlineCycles: new BN(payload.spenderLimitDeadlineCycles ?? 1),
          withdrawalDeadlineCycles: new BN(payload.withdrawalDeadlineCycles ?? 1),
          configModificationDeadlineCycles: new BN(payload.configModificationDeadlineCycles ?? 1),
          spenderLimitExecutionMode: toExecutionModeArg(payload.spenderLimitExecutionMode),
          withdrawalExecutionMode: toExecutionModeArg(payload.withdrawalExecutionMode),
          configModificationExecutionMode: toExecutionModeArg(payload.configModificationExecutionMode),
        })
        .accounts({
          creator: wallets.creator.publicKey,
          global: globalPda,
          creatorUsdc: creatorUsdcAta.address,
          treasuryUsdc,
          pool: poolPda,
          vault: vaultPda,
          usdcMint: mint,
          creatorMember: creatorMemberPda,
        })
        .signers([wallets.creator])
        .rpc()

      return { tx, pool: poolPda.toBase58(), poolId: nextPoolId.toNumber(), vault: vaultPda.toBase58() }
    }

    case 'join_pool': {
      const { poolAddress, walletName = 'member2', initialDeposit = 25 } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for join_pool')
      const targetWallet = wallets[walletName as keyof typeof wallets]
      if (!targetWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      if (poolAccount.isClosing) {
        throw new Error('Pool is closing; new members cannot join')
      }
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      // Fund target wallet if needed
      const bal = await connection.getBalance(targetWallet.publicKey)
      if (bal < LAMPORTS_PER_SOL) {
        const sig = await connection.requestAirdrop(targetWallet.publicKey, 2 * LAMPORTS_PER_SOL)
        await connection.confirmTransaction(sig, 'confirmed')
      }

      const userUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, targetWallet.publicKey)
      const userUsdcBal = await getAccount(connection, userUsdcAta.address)
      const neededAtomic = BigInt(Math.floor(initialDeposit * 1e6))
      if (userUsdcBal.amount < neededAtomic) {
        await mintTo(connection, wallets.administrator, mint, userUsdcAta.address, wallets.administrator, neededAtomic + 500n * oneUsdc)
      }

      const [memberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), targetWallet.publicKey.toBuffer()], programId)

      const tx = await program.methods
        .joinPool({
          initialDeposit: new BN(neededAtomic.toString()),
          aliasHash: Array(32).fill(1),
          encryptionPublicKey: Array(32).fill(2),
        })
        .accounts({
          user: targetWallet.publicKey,
          global: globalPda,
          pool: poolPubkey,
          userUsdc: userUsdcAta.address,
          vault: poolAccount.vault,
          member: memberPda,
        })
        .signers([targetWallet])
        .rpc()

      return { tx, member: memberPda.toBase58(), pool: poolAddress, wallet: targetWallet.publicKey.toBase58() }
    }

    case 'deposit': {
      const { poolAddress, walletName = 'creator', amount = 50 } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for deposit')
      const targetWallet = wallets[walletName as keyof typeof wallets]
      if (!targetWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      if (poolAccount.isClosing) {
        throw new Error('Pool is closing; deposits are blocked')
      }
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      const [memberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), targetWallet.publicKey.toBuffer()], programId)
      const userUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, targetWallet.publicKey)
      const amountAtomic = BigInt(Math.floor(amount * 1e6))

      const tx = await program.methods
        .deposit(new BN(amountAtomic.toString()))
        .accounts({
          memberWallet: targetWallet.publicKey,
          global: globalPda,
          pool: poolPubkey,
          member: memberPda,
          sourceUsdc: userUsdcAta.address,
          vault: poolAccount.vault,
        })
        .signers([targetWallet])
        .rpc()

      return { tx, pool: poolAddress, amount, member: memberPda.toBase58() }
    }

    case 'set_alias': {
      const { poolAddress, walletName = 'creator', aliasText = 'Alice', encryptionKeyText = 'Key1' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for set_alias')
      const targetWallet = wallets[walletName as keyof typeof wallets]
      if (!targetWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const [memberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), targetWallet.publicKey.toBuffer()], programId)

      const aliasHash = Array(32).fill(0)
      Buffer.from(aliasText).copy(Buffer.from(aliasHash))
      const encKey = Array(32).fill(0)
      Buffer.from(encryptionKeyText).copy(Buffer.from(encKey))

      const program = await getProgram()
      const tx = await program.methods
        .setAlias(aliasHash, encKey)
        .accounts({
          memberWallet: targetWallet.publicKey,
          pool: poolPubkey,
          member: memberPda,
        })
        .signers([targetWallet])
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58(), aliasText }
    }

    case 'set_paused': {
      const { poolAddress, walletName, paused } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for set_paused')
      if (!walletName || !(wallets as any)[walletName]) throw new Error(`Invalid wallet name: ${walletName}`)
      if (typeof paused !== 'boolean') throw new Error('Missing or invalid paused parameter for set_paused')

      const memberKp = (wallets as any)[walletName]
      const poolPubkey = new PublicKey(poolAddress)
      const [memberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), memberKp.publicKey.toBuffer()],
        programId
      )

      const program = await getProgram()
      const tx = await program.methods
        .setPaused(paused)
        .accounts({
          memberWallet: memberKp.publicKey,
          member: memberPda,
          pool: poolPubkey,
        })
        .signers([memberKp])
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58(), paused }
    }

    case 'roll_cycle': {
      const { poolAddress, crankerWallet } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for roll_cycle')
      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const currentCycle = new BN(poolAccount.currentCycle.toString())
      const nextCycle = currentCycle.addn(1)

      const poolMembers = await program.account.member.all([
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ])
      const poolProposals = await program.account.proposal.all([
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ])
      const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = []

      // Members must be passed as writable so roll_cycle updates funded statuses and moves surplus
      for (const item of poolMembers) {
        remainingAccounts.push({ pubkey: item.publicKey, isWritable: true, isSigner: false })
      }

      for (const item of poolProposals) {
        const p = item.account
        const stateIsActive = p.state.open || p.state.queued
        const isVotingActive = currentCycle.gte(p.votingCycle)
        const isDeadline = currentCycle.gte(p.deadlineCycle)
        const isThresholdMetMode = parseExecutionMode(p.executionMode) === 'threshold_met'
        const propThreshold = p.voteThreshold ?? poolAccount.voteThreshold
        const passed = p.yesVotes >= propThreshold && p.yesVotes > p.noVotes
        const shouldResolve = isThresholdMetMode ? (passed || isDeadline) : isDeadline

        if (stateIsActive && isVotingActive && shouldResolve) {
          remainingAccounts.push({ pubkey: item.publicKey, isWritable: true, isSigner: false })
          if (p.action.setSpenderLimit) {
            const targetMember = p.action.setSpenderLimit.member
            remainingAccounts.push({ pubkey: targetMember, isWritable: true, isSigner: false })
            const [spenderCyclePda] = PublicKey.findProgramAddressSync(
              [Buffer.from('cycle'), poolPubkey.toBuffer(), targetMember.toBuffer(), nextCycle.toArrayLike(Buffer, 'le', 8)],
              programId
            )
            remainingAccounts.push({ pubkey: spenderCyclePda, isWritable: true, isSigner: false })
          }
        }
      }

      const crankerKp = crankerWallet && (wallets as Record<string, Keypair>)[crankerWallet]
        ? (wallets as Record<string, Keypair>)[crankerWallet]
        : wallets.administrator

      const tx = await program.methods
        .rollCycle()
        .accounts({
          pool: poolPubkey,
          cranker: crankerKp.publicKey,
        })
        .remainingAccounts(remainingAccounts)
        .signers([crankerKp])
        .rpc()

      return { tx, pool: poolAddress }
    }

    case 'test_roll_cycle': {
      const { poolAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_roll_cycle')
      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const currentCycle = new BN(poolAccount.currentCycle.toString())
      const nextCycle = currentCycle.addn(1)

      const poolMembers = await program.account.member.all([
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ])
      const poolProposals = await program.account.proposal.all([
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ])
      const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = []

      // Members must be passed in pointer-chain order as writable so test_roll_cycle updates funded statuses and moves surplus
      const memberMap = new Map<string, any>()
      for (const item of poolMembers) {
        memberMap.set(item.publicKey.toBase58(), item)
      }
      let currentMemberKey = poolAccount.rolloverCursor ?? poolAccount.headMember
      while (currentMemberKey) {
        const keyStr = (currentMemberKey as any).toBase58 ? (currentMemberKey as any).toBase58() : new PublicKey(currentMemberKey).toBase58()
        remainingAccounts.push({ pubkey: new PublicKey(keyStr), isWritable: true, isSigner: false })
        const memberItem = memberMap.get(keyStr)
        currentMemberKey = memberItem?.account?.nextMember ?? null
      }

      for (const item of poolProposals) {
        const p = item.account
        const stateIsActive = p.state.open || p.state.queued
        const isVotingActive = currentCycle.gte(p.votingCycle)
        const isDeadline = currentCycle.gte(p.deadlineCycle)
        const isThresholdMetMode = parseExecutionMode(p.executionMode) === 'threshold_met'
        const propThreshold = p.voteThreshold ?? poolAccount.voteThreshold
        const passed = p.yesVotes >= propThreshold && p.yesVotes > p.noVotes
        const shouldResolve = isThresholdMetMode ? (passed || isDeadline) : isDeadline

        if (stateIsActive && isVotingActive && shouldResolve) {
          remainingAccounts.push({ pubkey: item.publicKey, isWritable: true, isSigner: false })
          if (p.action.setSpenderLimit) {
            const targetMember = p.action.setSpenderLimit.member
            remainingAccounts.push({ pubkey: targetMember, isWritable: true, isSigner: false })
            const [spenderCyclePda] = PublicKey.findProgramAddressSync(
              [Buffer.from('cycle'), poolPubkey.toBuffer(), targetMember.toBuffer(), nextCycle.toArrayLike(Buffer, 'le', 8)],
              programId
            )
            remainingAccounts.push({ pubkey: spenderCyclePda, isWritable: true, isSigner: false })
          }
        }
      }

      const tx = await program.methods
        .testRollCycle()
        .accounts({
          pool: poolPubkey,
        })
        .remainingAccounts(remainingAccounts)
        .rpc()

      return { tx, pool: poolAddress }
    }

    case 'test_advance_cycles': {
      const { poolAddress, count = 1 } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_advance_cycles')
      if (typeof count !== 'number' || count <= 0) throw new Error(`Invalid count for test_advance_cycles: ${count}`)
      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const currentCycle = new BN(poolAccount.currentCycle.toString())
      const nextCycle = currentCycle.addn(count)

      const poolProposals = await program.account.proposal.all([
        { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
      ])
      const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = []
      for (const item of poolProposals) {
        const p = item.account
        const stateIsActive = p.state.open || p.state.queued
        const isVotingActive = nextCycle.gt(p.votingCycle)
        const isDeadline = nextCycle.gt(p.deadlineCycle)
        const isThresholdMetMode = parseExecutionMode(p.executionMode) === 'threshold_met'
        const propThreshold = p.voteThreshold ?? poolAccount.voteThreshold
        const passed = p.yesVotes >= propThreshold && p.yesVotes > p.noVotes
        const shouldResolve = isThresholdMetMode ? (passed || isDeadline) : isDeadline

        if (stateIsActive && isVotingActive && shouldResolve) {
          remainingAccounts.push({ pubkey: item.publicKey, isWritable: true, isSigner: false })
          if (p.action.setSpenderLimit) {
            const targetMember = p.action.setSpenderLimit.member
            remainingAccounts.push({ pubkey: targetMember, isWritable: true, isSigner: false })
            const [spenderCyclePda] = PublicKey.findProgramAddressSync(
              [Buffer.from('cycle'), poolPubkey.toBuffer(), targetMember.toBuffer(), nextCycle.toArrayLike(Buffer, 'le', 8)],
              programId
            )
            remainingAccounts.push({ pubkey: spenderCyclePda, isWritable: true, isSigner: false })
          }
        }
      }

      const tx = await program.methods
        .testAdvanceCycles(new BN(count))
        .accounts({
          pool: poolPubkey,
        })
        .remainingAccounts(remainingAccounts)
        .rpc()

      return { tx, pool: poolAddress, count }
    }

    case 'test_set_cycle': {
      const { poolAddress, cycle } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_set_cycle')
      if (typeof cycle !== 'number' || cycle < 0) throw new Error(`Invalid cycle for test_set_cycle: ${cycle}`)
      const poolPubkey = new PublicKey(poolAddress)

      const program = await getProgram()
      const tx = await program.methods
        .testSetCycle(new BN(cycle))
        .accounts({
          pool: poolPubkey,
        })
        .rpc()

      return { tx, pool: poolAddress, cycle }
    }

    case 'test_finalize_proposal': {
      const { poolAddress, proposalAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_finalize_proposal')
      if (!proposalAddress) throw new Error('Missing proposalAddress for test_finalize_proposal')
      const poolPubkey = new PublicKey(poolAddress)
      const proposalPubkey = new PublicKey(proposalAddress)

      const program = await getProgram()
      const tx = await program.methods
        .testFinalizeProposal()
        .accounts({
          pool: poolPubkey,
          proposal: proposalPubkey,
        })
        .rpc()

      return { tx, pool: poolAddress, proposal: proposalAddress }
    }

    case 'test_reset_member_allowance': {
      const { poolAddress, walletName = 'creator' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_reset_member_allowance')
      const targetWallet = wallets[walletName as keyof typeof wallets]
      if (!targetWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const [memberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), targetWallet.publicKey.toBuffer()],
        programId
      )

      const program = await getProgram()
      const tx = await program.methods
        .testResetMemberAllowance()
        .accounts({
          pool: poolPubkey,
          member: memberPda,
        })
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58() }
    }

    case 'create_proposal': {
      const { poolAddress, proposerWalletName = 'creator', actionKind = 'SetSpenderLimit', targetWalletName = 'member2', cap = 100, requestAddress = '' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for create_proposal')
      const proposer = wallets[proposerWalletName as keyof typeof wallets]
      if (!proposer) throw new Error(`Invalid proposerWalletName: ${proposerWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)

      let actionPayload: any
      if (actionKind === 'SetSpenderLimit') {
        const targetWallet = wallets[targetWalletName as keyof typeof wallets]
        if (!targetWallet) throw new Error(`Invalid targetWalletName: ${targetWalletName}`)
        const [targetMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), targetWallet.publicKey.toBuffer()], programId)
        actionPayload = {
          setSpenderLimit: {
            member: targetMemberPda,
            cap: new BN(BigInt(Math.floor(cap * 1e6)).toString()),
          },
        }
      } else if (actionKind === 'ApproveWithdrawal') {
        if (!requestAddress) throw new Error('Missing requestAddress for ApproveWithdrawal action')
        actionPayload = {
          approveWithdrawal: {
            request: new PublicKey(requestAddress),
          },
        }
      } else if (actionKind === 'ConfigurationModification' || actionKind === 'configuration_modification') {
        const {
          voteThreshold = 5001,
          cycleDurationSeconds = 2592000,
          memberObligationAmount = 10,
          spenderLimitDeadlineCycles = 1,
          withdrawalDeadlineCycles = 1,
          configModificationDeadlineCycles = 1,
        } = payload
        actionPayload = {
          configurationModification: {
            voteThreshold: Number(voteThreshold),
            cycleDurationSeconds: new BN(cycleDurationSeconds),
            memberObligationAmount: new BN(BigInt(Math.floor(memberObligationAmount * 1e6)).toString()),
            spenderLimitDeadlineCycles: new BN(spenderLimitDeadlineCycles),
            withdrawalDeadlineCycles: new BN(withdrawalDeadlineCycles),
            configModificationDeadlineCycles: new BN(configModificationDeadlineCycles),
            spenderLimitExecutionMode: toExecutionModeArg(payload.spenderLimitExecutionMode),
            withdrawalExecutionMode: toExecutionModeArg(payload.withdrawalExecutionMode),
            configModificationExecutionMode: toExecutionModeArg(payload.configModificationExecutionMode),
          },
        }
      } else if (actionKind === 'ClosePool' || actionKind === 'close_pool') {
        actionPayload = {
          closePool: {},
        }
      } else if (actionKind === 'EvictMember' || actionKind === 'evict_member') {
        let targetMemberPubkey: PublicKey
        if (payload.targetMemberAddress) {
          targetMemberPubkey = new PublicKey(payload.targetMemberAddress)
        } else if (payload.targetWalletName) {
          const tw = wallets[payload.targetWalletName as keyof typeof wallets]
          if (!tw) throw new Error(`Invalid targetWalletName: ${payload.targetWalletName}`)
          const [pda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), tw.publicKey.toBuffer()], programId)
          targetMemberPubkey = pda
        } else if (payload.targetMember) {
          targetMemberPubkey = new PublicKey(payload.targetMember)
        } else {
          throw new Error('Missing targetMember or targetWalletName for EvictMember proposal')
        }
        actionPayload = {
          evictMember: {
            member: targetMemberPubkey,
          },
        }
      } else if (actionKind === 'AdmitMember' || actionKind === 'admit_member') {
        let candidateWalletPubkey: PublicKey
        if (payload.candidateWallet) {
          candidateWalletPubkey = new PublicKey(payload.candidateWallet)
        } else if (payload.candidateWalletAddress) {
          candidateWalletPubkey = new PublicKey(payload.candidateWalletAddress)
        } else if (payload.candidateWalletName) {
          const cw = wallets[payload.candidateWalletName as keyof typeof wallets]
          if (!cw) throw new Error(`Invalid candidateWalletName: ${payload.candidateWalletName}`)
          candidateWalletPubkey = cw.publicKey
        } else {
          throw new Error('Missing candidateWallet for AdmitMember proposal')
        }

        let vouchedByPubkey: PublicKey
        if (payload.vouchedBy) {
          vouchedByPubkey = new PublicKey(payload.vouchedBy)
        } else if (payload.inviterMemberAddress) {
          vouchedByPubkey = new PublicKey(payload.inviterMemberAddress)
        } else if (payload.inviterWalletName) {
          const iw = wallets[payload.inviterWalletName as keyof typeof wallets]
          if (!iw) throw new Error(`Invalid inviterWalletName: ${payload.inviterWalletName}`)
          const [pda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), iw.publicKey.toBuffer()], programId)
          vouchedByPubkey = pda
        } else {
          const [proposerMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), proposer.publicKey.toBuffer()], programId)
          vouchedByPubkey = proposerMemberPda
        }

        actionPayload = {
          admitMember: {
            candidateWallet: candidateWalletPubkey,
            vouchedBy: vouchedByPubkey,
          },
        }
      } else {
        throw new Error(`Unsupported proposal action kind: ${actionKind}`)
      }

      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const nextProposalId = new BN(poolAccount.nextProposalId.toString())

      const [proposerMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), proposer.publicKey.toBuffer()], programId)
      const [proposalPda] = PublicKey.findProgramAddressSync([Buffer.from('proposal'), poolPubkey.toBuffer(), nextProposalId.toArrayLike(Buffer, 'le', 8)], programId)

      const tx = await program.methods
        .createProposal(actionPayload)
        .accounts({
          proposerWallet: proposer.publicKey,
          pool: poolPubkey,
          proposer: proposerMemberPda,
          proposal: proposalPda,
        })
        .signers([proposer])
        .rpc()

      return { tx, proposal: proposalPda.toBase58(), proposalId: nextProposalId.toNumber(), pool: poolAddress }
    }

    case 'vote': {
      const { proposalAddress, voterWalletName = 'creator', approve = true } = payload
      if (!proposalAddress) throw new Error('Missing proposalAddress for vote')
      const voter = wallets[voterWalletName as keyof typeof wallets]
      if (!voter) throw new Error(`Invalid voterWalletName: ${voterWalletName}`)

      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)
      const [voterMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), proposalAccount.pool.toBuffer(), voter.publicKey.toBuffer()], programId)
      const [voteReceiptPda] = PublicKey.findProgramAddressSync([Buffer.from('vote'), proposalPubkey.toBuffer(), voterMemberPda.toBuffer()], programId)

      const tx = await program.methods
        .vote(approve)
        .accounts({
          voterWallet: voter.publicKey,
          pool: proposalAccount.pool,
          proposal: proposalPubkey,
          voter: voterMemberPda,
          receipt: voteReceiptPda,
        })
        .signers([voter])
        .rpc()

      return { tx, proposal: proposalAddress, voter: voter.publicKey.toBase58(), approve }
    }

    case 'finalize_proposal': {
      const { proposalAddress } = payload
      if (!proposalAddress) throw new Error('Missing proposalAddress for finalize_proposal')
      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)

      const tx = await program.methods
        .finalizeProposal()
        .accounts({
          pool: proposalAccount.pool,
          proposal: proposalPubkey,
        })
        .rpc()

      return { tx, proposal: proposalAddress }
    }

    case 'execute_spender_limit': {
      const { proposalAddress, executorWalletName = 'creator' } = payload
      if (!proposalAddress) throw new Error('Missing proposalAddress for execute_spender_limit')
      const executor = wallets[executorWalletName as keyof typeof wallets]
      if (!executor) throw new Error(`Invalid executorWalletName: ${executorWalletName}`)

      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)
      const poolAccount = await program.account.pool.fetch(proposalAccount.pool)

      if (!proposalAccount.action.setSpenderLimit) {
        throw new Error('Proposal action is not SetSpenderLimit.')
      }
      const targetMemberPubkey = proposalAccount.action.setSpenderLimit.member
      const currentCycle = new BN(poolAccount.currentCycle.toString())
      const [spenderCyclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('cycle'), proposalAccount.pool.toBuffer(), targetMemberPubkey.toBuffer(), currentCycle.toArrayLike(Buffer, 'le', 8)],
        programId
      )

      const tx = await program.methods
        .executeSpenderLimit()
        .accounts({
          executor: executor.publicKey,
          pool: proposalAccount.pool,
          proposal: proposalPubkey,
          spenderMember: targetMemberPubkey,
          spenderCycle: spenderCyclePda,
        })
        .signers([executor])
        .rpc()

      return { tx, proposal: proposalAddress, spenderCycle: spenderCyclePda.toBase58() }
    }

    case 'execute_configuration_modification': {
      const { proposalAddress, executorWalletName = 'creator' } = payload
      if (!proposalAddress) throw new Error('Missing proposalAddress for execute_configuration_modification')
      const executor = wallets[executorWalletName as keyof typeof wallets]
      if (!executor) throw new Error(`Invalid executorWalletName: ${executorWalletName}`)

      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)

      if (!proposalAccount.action.configurationModification) {
        throw new Error('Proposal action is not ConfigurationModification.')
      }

      const tx = await program.methods
        .executeConfigurationModification()
        .accounts({
          executor: executor.publicKey,
          pool: proposalAccount.pool,
          proposal: proposalPubkey,
        })
        .signers([executor])
        .rpc()

      return { tx, proposal: proposalAddress, pool: proposalAccount.pool.toBase58() }
    }

    case 'execute_close_pool': {
      const { poolAddress, proposalAddress, callerWalletName = 'creator' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for execute_close_pool')
      if (!proposalAddress) throw new Error('Missing proposalAddress for execute_close_pool')
      const caller = wallets[callerWalletName as keyof typeof wallets]
      if (!caller) throw new Error(`Invalid callerWalletName: ${callerWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)

      const tx = await program.methods
        .executeClosePool()
        .accounts({
          caller: caller.publicKey,
          global: globalPda,
          pool: poolPubkey,
          proposal: proposalPubkey,
          vault: poolAccount.vault,
        })
        .signers([caller])
        .rpc()

      return { tx, pool: poolAddress, proposal: proposalAddress }
    }

    case 'execute_evict_member': {
      const { poolAddress, proposalAddress, callerWalletName = 'creator', targetMemberAddress, prevMemberAddress, targetUsdcAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for execute_evict_member')
      if (!proposalAddress) throw new Error('Missing proposalAddress for execute_evict_member')
      const caller = wallets[callerWalletName as keyof typeof wallets]
      if (!caller) throw new Error(`Invalid callerWalletName: ${callerWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)
      const poolAccount = await program.account.pool.fetch(poolPubkey)

      let targetMemberPubkey: PublicKey
      if (targetMemberAddress) {
        targetMemberPubkey = new PublicKey(targetMemberAddress)
      } else if (proposalAccount.action.evictMember) {
        targetMemberPubkey = proposalAccount.action.evictMember.member
      } else {
        throw new Error('Could not determine target member for execute_evict_member')
      }

      let prevMemberPubkey: PublicKey | null = null
      if (prevMemberAddress) {
        prevMemberPubkey = new PublicKey(prevMemberAddress)
      } else if (poolAccount.headMember && !poolAccount.headMember.equals(targetMemberPubkey)) {
        const allMembers = await program.account.member.all([
          { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
        ])
        const prev = allMembers.find((m: any) => m.account.nextMember && m.account.nextMember.equals(targetMemberPubkey))
        if (prev) {
          prevMemberPubkey = prev.publicKey
        }
      }

      const tx = await program.methods
        .executeEvictMember()
        .accounts({
          caller: caller.publicKey,
          global: globalPda,
          pool: poolPubkey,
          proposal: proposalPubkey,
          targetMember: targetMemberPubkey,
          prevMember: prevMemberPubkey,
          vault: poolAccount.vault,
          targetUsdc: targetUsdcAddress ? new PublicKey(targetUsdcAddress) : null,
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        })
        .signers([caller])
        .rpc()

      return { tx, pool: poolAddress, proposal: proposalAddress, evictedMember: targetMemberPubkey.toBase58() }
    }

    case 'execute_admit_member': {
      const { poolAddress, proposalAddress, payerWalletName = 'creator' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for execute_admit_member')
      if (!proposalAddress) throw new Error('Missing proposalAddress for execute_admit_member')
      const payer = wallets[payerWalletName as keyof typeof wallets]
      if (!payer) throw new Error(`Invalid payerWalletName: ${payerWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const proposalPubkey = new PublicKey(proposalAddress)
      const program = await getProgram()
      const proposalAccount = await program.account.proposal.fetch(proposalPubkey)

      if (!proposalAccount.action.admitMember) {
        throw new Error('Proposal action is not AdmitMember.')
      }

      const candidateWalletPubkey = proposalAccount.action.admitMember.candidateWallet
      const inviterMemberPubkey = proposalAccount.action.admitMember.vouchedBy

      const [candidateMemberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), candidateWalletPubkey.toBuffer()],
        programId
      )

      const tx = await program.methods
        .executeAdmitMember()
        .accounts({
          payer: payer.publicKey,
          global: globalPda,
          pool: poolPubkey,
          proposal: proposalPubkey,
          inviterMember: inviterMemberPubkey,
          candidateMember: candidateMemberPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([payer])
        .rpc()

      return { tx, pool: poolAddress, proposal: proposalAddress, candidateMember: candidateMemberPda.toBase58() }
    }

    case 'claim_closure_refund': {
      const { poolAddress, walletName = 'creator' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for claim_closure_refund')
      const memberWallet = wallets[walletName as keyof typeof wallets]
      if (!memberWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      const [memberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), memberWallet.publicKey.toBuffer()],
        programId
      )
      const memberUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, memberWallet.publicKey)

      const tx = await program.methods
        .claimClosureRefund()
        .accounts({
          memberWallet: memberWallet.publicKey,
          global: globalPda,
          pool: poolPubkey,
          member: memberPda,
          vault: poolAccount.vault,
          memberUsdc: memberUsdcAta.address,
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        })
        .signers([memberWallet])
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58() }
    }

    case 'claim_eviction_refund': {
      const { poolAddress, walletName = 'member2' } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for claim_eviction_refund')
      const memberWallet = wallets[walletName as keyof typeof wallets]
      if (!memberWallet) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      const [memberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), memberWallet.publicKey.toBuffer()],
        programId
      )
      const userUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, memberWallet.publicKey)

      const tx = await program.methods
        .claimEvictionRefund()
        .accounts({
          memberWallet: memberWallet.publicKey,
          global: globalPda,
          pool: poolPubkey,
          member: memberPda,
          vault: poolAccount.vault,
          userUsdc: userUsdcAta.address,
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        })
        .signers([memberWallet])
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58() }
    }

    case 'leave_pool': {
      const { poolAddress, walletName = 'member2', prevMemberAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for leave_pool')
      const user = wallets[walletName as keyof typeof wallets]
      if (!user) throw new Error(`Invalid walletName: ${walletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint

      const [memberPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('member'), poolPubkey.toBuffer(), user.publicKey.toBuffer()],
        programId
      )
      const userUsdcAta = await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, user.publicKey)

      let prevMemberPubkey: PublicKey | null = null
      if (prevMemberAddress) {
        prevMemberPubkey = new PublicKey(prevMemberAddress)
      } else if (poolAccount.headMember && !poolAccount.headMember.equals(memberPda)) {
        const allMembers = await program.account.member.all([
          { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
        ])
        const prev = allMembers.find((m: any) => m.account.nextMember && m.account.nextMember.equals(memberPda))
        if (prev) {
          prevMemberPubkey = prev.publicKey
        }
      }

      const tx = await program.methods
        .leavePool()
        .accounts({
          user: user.publicKey,
          global: globalPda,
          pool: poolPubkey,
          member: memberPda,
          prevMember: prevMemberPubkey,
          userUsdc: userUsdcAta.address,
          vault: poolAccount.vault,
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        })
        .signers([user])
        .rpc()

      return { tx, pool: poolAddress, member: memberPda.toBase58() }
    }

    case 'request_withdrawal': {
      const { poolAddress, requesterWalletName = 'member2', recipientAddress, amount = 10, requiresProposal = false } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for request_withdrawal')
      const requester = wallets[requesterWalletName as keyof typeof wallets]
      if (!requester) throw new Error(`Invalid requesterWalletName: ${requesterWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)
      const program = await getProgram()
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const nextRequestId = new BN(poolAccount.nextRequestId.toString())

      const [memberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), requester.publicKey.toBuffer()], programId)
      const [requestPda] = PublicKey.findProgramAddressSync([Buffer.from('request'), poolPubkey.toBuffer(), nextRequestId.toArrayLike(Buffer, 'le', 8)], programId)

      const globalAccount = await program.account.globalConfig.fetch(globalPda)
      const mint = globalAccount.usdcMint
      const recipientPubkey = recipientAddress ? new PublicKey(recipientAddress) : (await getOrCreateAssociatedTokenAccount(connection, wallets.administrator, mint, requester.publicKey)).address

      const tx = await program.methods
        .requestWithdrawal({
          recipient: recipientPubkey,
          amount: new BN(BigInt(Math.floor(amount * 1e6)).toString()),
          justificationHash: Array(32).fill(9),
          requiresProposal,
        })
        .accounts({
          memberWallet: requester.publicKey,
          pool: poolPubkey,
          member: memberPda,
          request: requestPda,
        })
        .signers([requester])
        .rpc()

      return { tx, request: requestPda.toBase58(), requestId: nextRequestId.toNumber(), pool: poolAddress }
    }

    case 'spend': {
      const { requestAddress, executorWalletName = 'creator', proposalAddress = null } = payload
      if (!requestAddress) throw new Error('Missing requestAddress for spend')
      const executor = wallets[executorWalletName as keyof typeof wallets]
      if (!executor) throw new Error(`Invalid executorWalletName: ${executorWalletName}`)

      const requestPubkey = new PublicKey(requestAddress)
      const program = await getProgram()
      const requestAccount = await program.account.withdrawalRequest.fetch(requestPubkey)
      const poolAccount = await program.account.pool.fetch(requestAccount.pool)

      const [executorMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), requestAccount.pool.toBuffer(), executor.publicKey.toBuffer()], programId)
      const currentCycle = new BN(poolAccount.currentCycle.toString())
      const [spenderCyclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('cycle'), requestAccount.pool.toBuffer(), requestAccount.requester.toBuffer(), currentCycle.toArrayLike(Buffer, 'le', 8)],
        programId
      )

      const accounts: any = {
        executor: executor.publicKey,
        global: globalPda,
        pool: requestAccount.pool,
        executorMember: executorMemberPda,
        requesterMember: requestAccount.requester,
        spenderCycle: spenderCyclePda,
        request: requestPubkey,
        vault: poolAccount.vault,
        recipientUsdc: requestAccount.recipient,
        proposal: proposalAddress ? new PublicKey(proposalAddress) : null,
      }

      const tx = await program.methods
        .spend()
        .accounts(accounts)
        .signers([executor])
        .rpc()

      return { tx, request: requestAddress, amount: requestAccount.amount.toString() }
    }

    case 'sponsor_quote': {
      const { poolAddress, memberAddress, action = 'set_alias', chargeAtomic = '900' } = payload
      if (!poolAddress || !memberAddress) throw new Error('Missing poolAddress or memberAddress for sponsor_quote')

      const policies = new InMemorySponsorPolicyRepository()
      policies.upsertPool({
        pool: poolAddress,
        treasuryUsdcAccount: '7xLyWQHj83iVL161iwpByc8TJZbxEhBJ1nnyfKbSGT1D',
        sponsoredEnrollmentSlots: 5,
        memberCap: 24,
        currentMemberCount: 1,
        minimumJoinDepositAtomic: '10000000',
        actionAllowanceRemainingAtomicByMember: { [memberAddress]: '5000000' },
        actionChargeCapAtomicByKind: { [action]: '2000000' },
      })
      const signer = new HmacSha256QuoteSigner('dev-secret-quote-authority', 'ComFiQuoteAuthority')
      const service = new SponsorQuoteService({
        programId: poolAddress,
        signer,
        policies,
        actionPricing: { chargeFor: () => chargeAtomic },
        enrollmentPricing: { quoteCapacityIncrease: ({ additionalSponsoredSlots }) => String(additionalSponsoredSlots * 250000) },
        now: () => new Date(),
        nextQuoteId: () => `quote-${Date.now()}`,
      })

      const signed = await service.issueActionQuote({
        pool: poolAddress,
        member: memberAddress,
        action,
        actionDigest: 'e'.repeat(64),
      })

      const verified = await signer.verify!(canonicalQuote(signed.quote), signed.signature)

      const result: SponsorQuoteResult = {
        quoteId: signed.quote.quoteId,
        pool: signed.quote.pool,
        member: signed.quote.member,
        action: signed.quote.action,
        chargeUsdc: formatUsdc(signed.quote.chargeUsdc),
        expiresAt: signed.quote.expiresAt,
        signature: signed.signature,
        verified,
      }

      return result
    }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
