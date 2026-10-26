import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { checkPoolSetup, defaultPoolSetup, linkedUserAccounts, loadPoolSetup, poolSetupTransaction, requireWalletLink, savePoolSetup, tokenAddress, TOKEN_PROGRAM, usdcAmount, validatePoolSetup, verifyPoolSetup, walletMemberships } from '../src/pool-setup.ts'
import { USER_ACCOUNT_PROGRAM } from '../src/user-account.ts'
import { memberBytes } from './fixtures/governance.ts'
import { creator, poolAddress, poolBytes } from './fixtures/pool.ts'
const tag = (name: string) => createHash('sha256').update(name).digest().subarray(0, 8)
const program = new PublicKey('3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP')
function fixture() {
  const wallet = Keypair.generate().publicKey, userId = Buffer.alloc(32, 3)
  const user = PublicKey.findProgramAddressSync([Buffer.from('user'), userId], USER_ACCOUNT_PROGRAM)[0]
  const linkAddress = PublicKey.findProgramAddressSync([Buffer.from('wallet'), user.toBuffer(), wallet.toBuffer()], USER_ACCOUNT_PROGRAM)[0]
  const userData = Buffer.alloc(102); tag('account:UserAccount').copy(userData); userData[8] = 1; userId.copy(userData, 9)
  const linkData = Buffer.concat([tag('account:WalletLink'), user.toBuffer(), wallet.toBuffer(), Buffer.from([1, 255])])
  const account = { owner: USER_ACCOUNT_PROGRAM, data: userData }, link = { owner: USER_ACCOUNT_PROGRAM, data: linkData }
  const config = { owner: program, data: Buffer.alloc(146) }; tag('account:GlobalConfig').copy(config.data)
  const mint = Keypair.generate().publicKey; mint.toBuffer().copy(config.data, 40); wallet.toBuffer().copy(config.data, 72)
  const token = { owner: TOKEN_PROGRAM, data: Buffer.alloc(165) }; mint.toBuffer().copy(token.data); wallet.toBuffer().copy(token.data, 32); token.data.writeBigUInt64LE(50_000_000n, 64); token.data[108] = 1
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys[0].equals(program) ? [{ executable: true }, config] : [account, link],
    getAccountInfo: async () => token,
    getProgramAccounts: async () => [{ pubkey: linkAddress, account: link }],
  } as unknown as Connection
  return { wallet, user, linkAddress, account, link, config, token, mint, connection }
}
test('pool amounts preserve atomic precision and reject invalid settings', () => {
  assert.equal(usdcAmount('9007199254.740993'), 9_007_199_254_740_993n)
  for (const value of ['', 'NaN', '-1', '1e2', '1.0000001', '18446744073709.551616']) assert.throws(() => usdcAmount(value), /USDC/)
  for (const params of [{ minimumDeposit: '0' }, { obligation: '0' }, { initialDeposit: '9' }, { initialDeposit: '21' }, { memberCap: 2.5 }, { memberCap: 501 }, { cycleDays: Infinity }, { cycleDays: 0 }, { voteThreshold: 5000 }, { voteThreshold: NaN }]) assert.throws(() => validatePoolSetup({ ...defaultPoolSetup, ...params }), /Deposit|capacity|duration|threshold/)
})
test('account discovery checks live canonical user and wallet links', async () => {
  const f = fixture()
  assert.deepEqual(await linkedUserAccounts(f.connection, f.wallet), [f.user.toBase58()])
  f.link.data[72] = 0
  assert.deepEqual(await linkedUserAccounts(f.connection, f.wallet), [])
  await assert.rejects(() => requireWalletLink(f.connection, f.user, f.wallet), /no active link/)
  f.link.data[72] = 1; f.link.data[40] ^= 1
  await assert.rejects(() => requireWalletLink(f.connection, f.user, f.wallet), /no active link/)
  f.link.data[40] ^= 1; f.account.data[9] ^= 1
  await assert.rejects(() => requireWalletLink(f.connection, f.user, f.wallet), /Invalid UserAccount/)
  f.account.owner = program
  await assert.rejects(() => linkedUserAccounts(f.connection, f.wallet), /invalid owner/)
})
test('pool setup binds creator, funding ATA, deposit and canonical accounts to the selected wallet', async () => {
  const f = fixture(), plan = await poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup)
  const ix = plan.transaction.instructions[0]
  assert(ix.programId.equals(program)); assert(ix.keys[0].pubkey.equals(f.wallet)); assert(ix.keys[0].isSigner)
  assert(ix.keys[2].pubkey.equals(tokenAddress(f.wallet, f.mint)))
  assert(ix.data.subarray(0, 8).equals(tag('global:create_pool')))
  assert.equal(ix.data.readBigUInt64LE(28), 10_000_000n)
  assert.equal(ix.data.readBigUInt64LE(36), 1_000_000n)
  assert.equal(ix.keys.filter(k => k.isSigner).length, 1)
  f.token.data.writeBigUInt64LE(10_000_000n, 64)
  await assert.rejects(() => poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup), /Insufficient deployment USDC/)
  f.token.data[0] ^= 1
  await assert.rejects(() => poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup), /Fund the selected wallet/)
  f.config.data[136] = 1
  await assert.rejects(() => poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup), /paused/)
  f.config.data[136] = 0; f.config.data[0] ^= 1
  await assert.rejects(() => poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup), /Invalid global/)
})
test('wallet membership comes from Member state and rejects wrong ownership and bindings', async () => {
  const account = { owner: program, data: memberBytes() }, wallet = new PublicKey(creator)
  const connection = { getMultipleAccountsInfo: async () => [account] } as unknown as Connection
  assert.equal((await walletMemberships(connection, program, [poolAddress], wallet)).get(poolAddress)?.role, 'Admin')
  account.data[40] ^= 1
  await assert.rejects(() => walletMemberships(connection, program, [poolAddress], wallet), /does not match/)
  account.owner = USER_ACCOUNT_PROGRAM
  await assert.rejects(() => walletMemberships(connection, program, [poolAddress], wallet), /invalid owner/)
})
test('pool verification never treats a saved account link as deployment success', async () => {
  const f = fixture(), plan = await poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup)
  f.connection.getAccountInfo = async () => null
  await assert.rejects(() => verifyPoolSetup(f.connection, program, plan), /not been verified on-chain/)
  f.link.data[72] = 0
  await assert.rejects(() => verifyPoolSetup(f.connection, program, plan), /no active link/)
})

test('pool receipts round trip exact payments and reject corrupt or substituted records', async () => {
  const f = fixture(), { transaction: _, ...receipt } = await poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup)
  const raw = savePoolSetup(receipt, 'signature', 100)
  const loaded = loadPoolSetup(raw, f.wallet)
  assert(loaded.receipt.pool.equals(receipt.pool))
  assert.equal(loaded.receipt.deposit, 10_000_000n)
  assert.equal(loaded.signature, 'signature')
  assert.throws(() => loadPoolSetup('{', f.wallet), SyntaxError)
  assert.throws(() => loadPoolSetup(raw, Keypair.generate().publicKey), /does not match/)
  for (const patch of [{ version: 2 }, { expiry: -1 }, { signature: '' }, { deposit: '1' }, { enrollmentFee: '0' }, { source: program.toBase58() }]) {
    assert.throws(() => loadPoolSetup(JSON.stringify({ ...JSON.parse(raw), ...patch }), f.wallet), /Invalid saved|does not match/)
  }
  assert.throws(() => savePoolSetup(receipt, '', 100), /Invalid pending/)
  assert.throws(() => savePoolSetup(receipt, 'signature', NaN), /Invalid pending/)
})

test('pool readback checks approved parameters, creator and active Admin membership', async () => {
  const f = fixture(), plan = await poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup)
  const pool = poolBytes()
  f.wallet.toBuffer().copy(pool, 48); tokenAddress(plan.pool, plan.mint).toBuffer().copy(pool, 80)
  pool.writeBigUInt64LE(10_000_000n, 128); pool.writeUInt32LE(5001, 136)
  const member = memberBytes()
  plan.pool.toBuffer().copy(member, 8); f.wallet.toBuffer().copy(member, 40); member.writeBigUInt64LE(plan.deposit, 74)
  const original = f.connection.getMultipleAccountsInfo.bind(f.connection)
  f.connection.getAccountInfo = async () => ({ owner: program, data: pool }) as never
  f.connection.getMultipleAccountsInfo = async (addresses) => addresses.length === 1 ? [{ owner: program, data: member }] as never : original(addresses)
  assert.equal((await verifyPoolSetup(f.connection, program, plan)).role, 'Admin')
  f.connection.getSignatureStatuses = async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }) as never
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'verified')
  f.connection.getSignatureStatuses = async () => ({ value: [null] }) as never
  f.connection.getBlockHeight = async () => 101
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'verified')
  member[72] = 0
  await assert.rejects(() => verifyPoolSetup(f.connection, program, plan), /does not match/)
  member[72] = 2; pool.writeUInt32LE(6000, 136)
  await assert.rejects(() => verifyPoolSetup(f.connection, program, plan), /does not match/)
})

test('pending recovery preserves unconfirmed transactions and permits retries after definite failure', async () => {
  const f = fixture(), plan = await poolSetupTransaction(f.connection, program, f.user, f.wallet, defaultPoolSetup)
  let status: { err: unknown; confirmationStatus: string } | null = null
  let height = 50
  f.connection.getSignatureStatuses = async () => ({ value: [status] }) as never
  f.connection.getBlockHeight = async () => height
  const original = f.connection.getMultipleAccountsInfo.bind(f.connection)
  f.connection.getMultipleAccountsInfo = async addresses => addresses.length === 1 ? [null] : original(addresses)
  f.connection.getAccountInfo = async () => null
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'pending')
  height = 101
  status = { err: null, confirmationStatus: 'processed' }
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'pending')
  status = null
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'retryable')
  // A concurrent creator took the same pool ID. A definite failed signature is
  // enough to allow retry without mistaking their pool for our deployment.
  f.connection.getAccountInfo = async () => ({ owner: program, data: poolBytes() }) as never
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'retryable')
  status = { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }
  assert.equal(await checkPoolSetup(f.connection, program, plan, 'signature', 100), 'retryable')
  status = { err: null, confirmationStatus: 'confirmed' }
  await assert.rejects(() => checkPoolSetup(f.connection, program, plan, 'signature', 100), /does not match/)
  await assert.rejects(() => checkPoolSetup(f.connection, program, plan, '', 0), /Invalid pending/)
})
