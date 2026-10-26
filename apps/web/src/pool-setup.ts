import { Buffer } from 'buffer'
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js'
import { USER_ACCOUNT_PROGRAM, sha256 } from './user-account.ts'
import { decodeVotingMember, type VotingMember } from './governance.ts'
import { decodePoolAccountData } from './solana.ts'

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const seed = (value: string) => Buffer.from(value)
const tag = async (name: string) => Buffer.from((await sha256(seed(name))).slice(0, 8))
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))
function integer(value: bigint, size = 8): Buffer {
  const result = Buffer.alloc(size)
  if (size === 4) result.writeUInt32LE(Number(value), 0); else new DataView(result.buffer, result.byteOffset, result.byteLength).setBigUint64(0, value, true)
  return result
}
export function usdcAmount(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Enter a USDC amount with up to six decimal places.')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (amount > 0xffffffffffffffffn) throw new Error('USDC amount is too large.')
  return amount
}
export type PoolSetupParams = { minimumDeposit: string; obligation: string; initialDeposit: string; memberCap: number; cycleDays: number; voteThreshold: number }
export const defaultPoolSetup: PoolSetupParams = { minimumDeposit: '10', obligation: '10', initialDeposit: '10', memberCap: 24, cycleDays: 30, voteThreshold: 5001 }
export function validatePoolSetup(params: PoolSetupParams) {
  const minimum = usdcAmount(params.minimumDeposit), obligation = usdcAmount(params.obligation), deposit = usdcAmount(params.initialDeposit)
  if (minimum === 0n || obligation === 0n || deposit < minimum || deposit > 2n * obligation) throw new Error('Deposit must meet the positive minimum and be at most twice the cycle obligation.')
  if (!Number.isInteger(params.memberCap) || params.memberCap < 2 || params.memberCap > 500) throw new Error('Member capacity must be an integer from 2 to 500.')
  if (!Number.isInteger(params.cycleDays) || params.cycleDays < 1 || params.cycleDays > 365) throw new Error('Cycle duration must be an integer from 1 to 365 days.')
  if (!Number.isInteger(params.voteThreshold) || params.voteThreshold < 5001 || params.voteThreshold > 10000) throw new Error('Vote threshold must be an integer from 5001 to 10000 basis points.')
  return { minimum, obligation, deposit }
}
export function tokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0]
}
export async function requireWalletLink(connection: Connection, user: PublicKey, wallet: PublicKey): Promise<void> {
  const [linkAddress] = PublicKey.findProgramAddressSync([seed('wallet'), user.toBuffer(), wallet.toBuffer()], USER_ACCOUNT_PROGRAM)
  const [account, link] = await connection.getMultipleAccountsInfo([user, linkAddress], 'confirmed')
  if (!account || !link || !account.owner.equals(USER_ACCOUNT_PROGRAM) || !link.owner.equals(USER_ACCOUNT_PROGRAM)) throw new Error('UserAccount or wallet link is missing or has an invalid owner.')
  if (account.data.length !== 102 || !same(account.data.subarray(0, 8), await tag('account:UserAccount')) || account.data[8] !== 1 ||
    !PublicKey.findProgramAddressSync([seed('user'), account.data.subarray(9, 41)], USER_ACCOUNT_PROGRAM)[0].equals(user)) throw new Error('Invalid UserAccount data or address.')
  if (link.data.length !== 74 || !same(link.data.subarray(0, 8), await tag('account:WalletLink')) || !same(link.data.subarray(8, 40), user.toBytes()) ||
    !same(link.data.subarray(40, 72), wallet.toBytes()) || link.data[72] !== 1) throw new Error('The selected wallet has no active link to this UserAccount.')
}
export async function linkedUserAccounts(connection: Connection, wallet: PublicKey): Promise<string[]> {
  const links = await connection.getProgramAccounts(USER_ACCOUNT_PROGRAM, { commitment: 'confirmed', filters: [
    { dataSize: 74 }, { memcmp: { offset: 40, bytes: wallet.toBase58() } },
  ] })
  const walletTag = await tag('account:WalletLink')
  const users: string[] = []
  for (const { pubkey, account } of links) {
    if (!same(account.data.subarray(0, 8), walletTag)) continue
    if (account.data[72] !== 1) continue
    const user = new PublicKey(account.data.subarray(8, 40))
    const expected = PublicKey.findProgramAddressSync([seed('wallet'), user.toBuffer(), wallet.toBuffer()], USER_ACCOUNT_PROGRAM)[0]
    if (!pubkey.equals(expected)) throw new Error('Invalid wallet link address.')
    await requireWalletLink(connection, user, wallet)
    users.push(user.toBase58())
  }
  return [...new Set(users)].sort()
}
export async function walletMemberships(connection: Connection, program: PublicKey, pools: string[], wallet: PublicKey): Promise<Map<string, VotingMember>> {
  const result = new Map<string, VotingMember>()
  // getMultipleAccountsInfo accepts at most 100 addresses.
  for (let offset = 0; offset < pools.length; offset += 100) {
    const batch = pools.slice(offset, offset + 100)
    const addresses = batch.map(pool => PublicKey.findProgramAddressSync([seed('member'), new PublicKey(pool).toBuffer(), wallet.toBuffer()], program)[0])
    const accounts = await connection.getMultipleAccountsInfo(addresses, 'confirmed')
    if (accounts.length !== batch.length) throw new Error('Incomplete Member account response.')
    accounts.forEach((account, i) => {
      if (!account) return
      if (!account.owner.equals(program)) throw new Error('Member account has an invalid owner.')
      const member = decodeVotingMember(addresses[i].toBase58(), account.data)
      if (member.pool !== batch[i] || member.wallet !== wallet.toBase58()) throw new Error('Member account does not match the selected wallet and pool.')
      result.set(batch[i], member)
    })
  }
  return result
}
export async function poolSetupTransaction(connection: Connection, program: PublicKey, user: PublicKey, wallet: PublicKey, params: PoolSetupParams) {
  const { minimum, obligation, deposit } = validatePoolSetup(params)
  await requireWalletLink(connection, user, wallet)
  const [global] = PublicKey.findProgramAddressSync([seed('global')], program)
  const [deployment, config] = await connection.getMultipleAccountsInfo([program, global], 'confirmed')
  if (!deployment?.executable || !config || !config.owner.equals(program)) throw new Error('Initialize and deploy ComFi on this localnet before pool setup.')
  if (config.data.length !== 146 || !same(config.data.subarray(0, 8), await tag('account:GlobalConfig'))) throw new Error('Invalid global pool configuration.')
  if (config.data[136] !== 0) throw new Error('New pool creation is paused.')
  const mint = new PublicKey(config.data.subarray(40, 72)), treasury = new PublicKey(config.data.subarray(72, 104))
  const id = new DataView(config.data.buffer, config.data.byteOffset, config.data.byteLength).getBigUint64(137, true)
  const [pool] = PublicKey.findProgramAddressSync([seed('pool'), integer(id)], program)
  const vault = tokenAddress(pool, mint), source = tokenAddress(wallet, mint)
  const [member] = PublicKey.findProgramAddressSync([seed('member'), pool.toBuffer(), wallet.toBuffer()], program)
  const token = await connection.getAccountInfo(source, 'confirmed')
  if (!token || !token.owner.equals(TOKEN_PROGRAM) || token.data.length !== 165 || !same(token.data.subarray(0, 32), mint.toBytes()) ||
    !same(token.data.subarray(32, 64), wallet.toBytes()) || token.data[108] !== 1) throw new Error('Fund the selected wallet with the deployment test USDC before creating a pool.')
  const enrollmentFee = 1_000_000n
  if (new DataView(token.data.buffer, token.data.byteOffset, token.data.byteLength).getBigUint64(64, true) < deposit + enrollmentFee) throw new Error('Insufficient deployment USDC for the initial deposit and 1 USDC enrollment fee.')
  const data = Buffer.concat([await tag('global:create_pool'), integer(BigInt(params.memberCap), 4), integer(minimum), integer(obligation), integer(deposit), integer(enrollmentFee),
    integer(BigInt(params.voteThreshold), 4), integer(604800n), integer(86400n), integer(BigInt(params.cycleDays) * 86400n), integer(5_000_000n), integer(1_000_000n),
    Buffer.alloc(64), Buffer.from([0]), integer(1n), integer(1n), integer(2n), Buffer.from([0, 0, 0])])
  const keys = [wallet, global, source, treasury, pool, vault, mint, member, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SystemProgram.programId, SYSVAR_RENT_PUBKEY]
    .map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: [0, 1, 2, 3, 4, 5, 7].includes(i) }))
  const transaction = new Transaction().add(new TransactionInstruction({ programId: program, keys, data }))
  return { transaction, pool, member, mint, source, user, wallet, params, deposit, enrollmentFee }
}
export async function verifyPoolSetup(connection: Connection, program: PublicKey, plan: PoolSetupReceipt) {
  await requireWalletLink(connection, plan.user, plan.wallet)
  const info = await connection.getAccountInfo(plan.pool, 'confirmed')
  if (!info || !info.owner.equals(program)) throw new Error('Pool creation has not been verified on-chain. Check the transaction before retrying.')
  const pool = decodePoolAccountData(plan.pool.toBase58(), info.data)
  const member = (await walletMemberships(connection, program, [plan.pool.toBase58()], plan.wallet)).get(plan.pool.toBase58())
  if (pool.creator !== plan.wallet.toBase58() || pool.vault !== tokenAddress(plan.pool, plan.mint).toBase58() || !member || member.role !== 'Admin' || member.status !== 'Active' ||
    member.depositedTotal !== plan.deposit || pool.minimumDepositAtomic !== usdcAmount(plan.params.minimumDeposit) || pool.memberObligationAmountAtomic !== usdcAmount(plan.params.obligation) ||
    pool.memberCap !== plan.params.memberCap || pool.voteThreshold !== plan.params.voteThreshold || pool.cycleDurationSeconds !== BigInt(plan.params.cycleDays) * 86400n) throw new Error('Pool or Member state does not match the approved setup.')
  return member
}

// Only public transaction expectations are stored; no wallet or authenticator secrets.
export type PoolSetupReceipt = Omit<Awaited<ReturnType<typeof poolSetupTransaction>>, 'transaction'>
export async function checkPoolSetup(connection: Connection, program: PublicKey, receipt: PoolSetupReceipt, signature: string, expiry: number): Promise<'verified' | 'pending' | 'retryable'> {
  if (!signature || !Number.isSafeInteger(expiry) || expiry <= 0) throw new Error('Invalid pending pool transaction.')
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
  // Another creator can occupy this pool ID after our transaction fails.
  if (status?.err) return 'retryable'
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    await verifyPoolSetup(connection, program, receipt)
    return 'verified'
  }
  if (status) return 'pending'
  if (await connection.getBlockHeight('confirmed') <= expiry) return 'pending'
  // An expired, absent signature must not trigger a second deployment if its
  // matching pool exists. Read back the approved state before deciding.
  const pool = await connection.getAccountInfo(receipt.pool, 'confirmed')
  if (pool) {
    const decoded = decodePoolAccountData(receipt.pool.toBase58(), pool.data)
    if (decoded.creator === receipt.wallet.toBase58()) {
      await verifyPoolSetup(connection, program, receipt)
      return 'verified'
    }
  }
  return 'retryable'
}
export function savePoolSetup(receipt: PoolSetupReceipt, signature: string, expiry: number): string {
  if (!signature || !Number.isSafeInteger(expiry) || expiry <= 0) throw new Error('Invalid pending pool transaction.')
  return JSON.stringify({ version: 1, ...receipt, signature, expiry }, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
}
export function loadPoolSetup(raw: string, wallet: PublicKey) {
  const value = JSON.parse(raw)
  if (value?.version !== 1 || typeof value.signature !== 'string' || !value.signature || !Number.isSafeInteger(value.expiry) || value.expiry <= 0) throw new Error('Invalid saved pool deployment. The record was preserved.')
  const receipt: PoolSetupReceipt = {
    pool: new PublicKey(value.pool), member: new PublicKey(value.member), mint: new PublicKey(value.mint), source: new PublicKey(value.source),
    user: new PublicKey(value.user), wallet: new PublicKey(value.wallet), params: value.params,
    deposit: BigInt(value.deposit), enrollmentFee: BigInt(value.enrollmentFee),
  }
  const amounts = validatePoolSetup(receipt.params)
  if (!receipt.wallet.equals(wallet) || receipt.deposit !== amounts.deposit || receipt.enrollmentFee !== 1_000_000n || !receipt.source.equals(tokenAddress(wallet, receipt.mint))) throw new Error('Saved deployment does not match the selected wallet or payment.')
  return { receipt, signature: value.signature as string, expiry: value.expiry as number }
}
