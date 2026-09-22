import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as anchor from '@coral-xyz/anchor'
import BN from 'bn.js'
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { canonicalQuote, HmacSha256QuoteSigner, InMemorySponsorPolicyRepository, SponsorQuoteService } from '@comfi/sponsor-api'
import type { GlobalConfigInfo, MemberInfo, PoolInfo, ProposalInfo, SponsorQuoteResult, SystemStatus, WalletInfo, WithdrawalRequestInfo } from '../types.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const rpcUrl = process.env.VITE_SOLANA_RPC ?? process.env.COMFI_LOCALNET_RPC ?? 'http://127.0.0.1:8899'
const programId = new PublicKey('bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY')
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
    if (p.action.setSpenderLimit) {
      actionType = 'SetSpenderLimit'
      actionDetails = `Member: ${p.action.setSpenderLimit.member.toBase58().slice(0, 8)}… Cap: ${formatUsdc(p.action.setSpenderLimit.cap.toString())}`
    } else if (p.action.approveWithdrawal) {
      actionType = 'ApproveWithdrawal'
      actionDetails = `Request: ${p.action.approveWithdrawal.request.toBase58().slice(0, 8)}…`
    } else if (p.action.configurationModification) {
      actionType = 'ConfigurationModification'
      actionDetails = `Threshold: ${p.action.configurationModification.voteThreshold}, Cycle: ${p.action.configurationModification.cycleDurationSeconds.toString()}s, Obligation: ${formatUsdc(p.action.configurationModification.memberObligationAmount.toString())}`
    }

    let state: ProposalInfo['state'] = 'Open'
    if (p.state.executable) state = 'Executable'
    else if (p.state.executed) state = 'Executed'
    else if (p.state.rejected) state = 'Rejected'

    return {
      address: item.publicKey.toBase58(),
      pool: p.pool.toBase58(),
      id: Number(p.id),
      proposer: p.proposer.toBase58(),
      actionType,
      actionDetails,
      yesVotes: Number(p.yesVotes),
      noVotes: Number(p.noVotes),
      deadline: Number(p.deadline),
      executableAfter: Number(p.executableAfter),
      state,
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
  const program = await getProgram()
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId)

  switch (action) {
    case 'initialize_global': {
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
        voteThreshold = 2,
        votingPeriodSeconds = 604800,
        timelockSeconds = 86400,
        cycleDurationSeconds = 2592000,
        actionAllowancePerCycle = 5,
        maxSponsoredActionCharge = 1,
      } = payload

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
      const poolAccount = await program.account.pool.fetch(poolPubkey)
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
      const poolAccount = await program.account.pool.fetch(poolPubkey)
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

    case 'roll_cycle': {
      const { poolAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for roll_cycle')
      const poolPubkey = new PublicKey(poolAddress)

      const tx = await program.methods
        .rollCycle()
        .accounts({
          pool: poolPubkey,
        })
        .rpc()

      return { tx, pool: poolAddress }
    }

    case 'test_roll_cycle': {
      const { poolAddress } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_roll_cycle')
      const poolPubkey = new PublicKey(poolAddress)

      const tx = await program.methods
        .testRollCycle()
        .accounts({
          pool: poolPubkey,
        })
        .rpc()

      return { tx, pool: poolAddress }
    }

    case 'test_advance_cycles': {
      const { poolAddress, count = 1 } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_advance_cycles')
      if (typeof count !== 'number' || count <= 0) throw new Error(`Invalid count for test_advance_cycles: ${count}`)
      const poolPubkey = new PublicKey(poolAddress)

      const tx = await program.methods
        .testAdvanceCycles(new BN(count))
        .accounts({
          pool: poolPubkey,
        })
        .rpc()

      return { tx, pool: poolAddress, count }
    }

    case 'test_set_cycle': {
      const { poolAddress, cycle } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for test_set_cycle')
      if (typeof cycle !== 'number' || cycle < 0) throw new Error(`Invalid cycle for test_set_cycle: ${cycle}`)
      const poolPubkey = new PublicKey(poolAddress)

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
      const poolAccount = await program.account.pool.fetch(poolPubkey)
      const nextProposalId = new BN(poolAccount.nextProposalId.toString())

      const [proposerMemberPda] = PublicKey.findProgramAddressSync([Buffer.from('member'), poolPubkey.toBuffer(), proposer.publicKey.toBuffer()], programId)
      const [proposalPda] = PublicKey.findProgramAddressSync([Buffer.from('proposal'), poolPubkey.toBuffer(), nextProposalId.toArrayLike(Buffer, 'le', 8)], programId)

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
          voteThreshold = 2,
          cycleDurationSeconds = 2592000,
          memberObligationAmount = 10,
        } = payload
        actionPayload = {
          configurationModification: {
            voteThreshold: Number(voteThreshold),
            cycleDurationSeconds: new BN(cycleDurationSeconds),
            memberObligationAmount: new BN(BigInt(Math.floor(memberObligationAmount * 1e6)).toString()),
          },
        }
      } else {
        throw new Error(`Unsupported proposal action kind: ${actionKind}`)
      }

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

    case 'request_withdrawal': {
      const { poolAddress, requesterWalletName = 'member2', recipientAddress, amount = 10, requiresProposal = false } = payload
      if (!poolAddress) throw new Error('Missing poolAddress for request_withdrawal')
      const requester = wallets[requesterWalletName as keyof typeof wallets]
      if (!requester) throw new Error(`Invalid requesterWalletName: ${requesterWalletName}`)

      const poolPubkey = new PublicKey(poolAddress)
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
