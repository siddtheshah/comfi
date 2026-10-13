import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicKey, verify } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { confirmWalletTransaction } from '../src/transaction-confirmation.ts'
import {
  accountAddresses, accountChainContext, approvalExpiry, authenticator, bytes, creationTransaction, credentialStorageKey, fetchUserAccount,
  hex, newCredential, openCredential, parseCredentialBackup, parseCredentialRecord, profileTransaction, requireAccountWallet,
  sealCredential, sha256, unhex, USER_ACCOUNT_PROGRAM,
} from '../src/user-account.ts'

test('passcode encrypts an authenticator and binds it to the wallet and chain', async () => {
  const credential = await newCredential()
  const context = credentialStorageKey('test-genesis', Keypair.generate().publicKey)
  const sealed = await sealCredential(credential, 'correct passcode', context)
  assert(!JSON.stringify(sealed).includes(credential.privateKey.d!))
  assert(!JSON.stringify(sealed).includes('correct passcode'))
  assert.deepEqual(await openCredential(sealed, 'correct passcode', context), credential)
  await assert.rejects(() => openCredential(sealed, 'wrong passcode', context), /Incorrect passcode/)
  await assert.rejects(() => openCredential(sealed, 'correct passcode', context + ':other'), /Incorrect passcode/)
  const changed = { ...sealed, ciphertext: (sealed.ciphertext[0] === '0' ? '1' : '0') + sealed.ciphertext.slice(1) }
  await assert.rejects(() => openCredential(changed, 'correct passcode', context), /damaged account credential/)
  for (const passcode of ['', 'short', 'x'.repeat(129)]) await assert.rejects(() => sealCredential(credential, passcode, context), /8–128/)
  assert.throws(() => parseCredentialRecord('{"version":2}'), /Unsupported account credential/)
  assert.throws(() => parseCredentialRecord(JSON.stringify({ ...sealed, iv: '00' })), /Invalid account credential encoding/)
  assert.throws(() => unhex('gg'), /Invalid account credential encoding/)
  const backup = JSON.stringify({ storageKey: context, credential: sealed })
  assert.deepEqual(parseCredentialBackup(backup, context), sealed)
  assert.throws(() => parseCredentialBackup(backup, context + ':other'), /different base wallet or localnet/)
  assert.throws(() => parseCredentialBackup(JSON.stringify({ storageKey: context, credential: {} }), context), /Unsupported account credential/)
})

test('account actions require a connected real wallet on localnet', () => {
  const wallet = Keypair.generate().publicKey.toBase58()
  assert.equal(requireAccountWallet('localnet', 'http://127.0.0.1:8899', 'in-browser', wallet).toBase58(), wallet)
  for (const [network, endpoint] of [['devnet', 'https://api.devnet.solana.com'], ['localnet', 'http://localhost.evil.com'], ['localnet', 'http://user:password@localhost:8899']]) {
    assert.throws(() => requireAccountWallet(network, endpoint, 'in-browser', wallet), /localnet RPC/)
  }
  assert.throws(() => requireAccountWallet('localnet', 'http://localhost:8899', 'mock', wallet), /Connect a base wallet/)
  assert.throws(() => requireAccountWallet('localnet', 'http://localhost:8899', 'phantom'), /Connect a base wallet/)
})

test('browser authenticator signs real low-S P-256 proofs and fits the transaction budget', async () => {
  const credential = await newCredential()
  const auth = await authenticator(credential)
  const wallet = Keypair.generate()
  const addresses = await accountAddresses(auth, wallet.publicKey)
  const create = await creationTransaction(auth, wallet.publicKey, 1800000000n)
  await assert.rejects(() => creationTransaction(auth, wallet.publicKey, -1n), /sequence or expiry/)
  const proof = create.instructions[0].data
  const key = createPublicKey({ key: { ...credential.privateKey, d: undefined }, format: 'jwk' })
  assert.equal(proof.length, 182)
  assert.equal(verify('sha256', proof.subarray(113), { key, dsaEncoding: 'ieee-p1363' }, proof.subarray(16, 80)), true)
  const damaged = Buffer.from(proof.subarray(113)); damaged[0] ^= 1
  assert.equal(verify('sha256', damaged, { key, dsaEncoding: 'ieee-p1363' }, proof.subarray(16, 80)), false)
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
  assert(BigInt(`0x${proof.subarray(48, 80).toString('hex')}`) <= order / 2n)
  create.recentBlockhash = PublicKey.default.toBase58(); create.feePayer = wallet.publicKey; create.sign(wallet)
  assert(create.serialize().length <= 1232)
  assert(create.instructions[1].keys[0].pubkey.equals(wallet.publicKey))
  assert(create.instructions[1].keys[1].pubkey.equals(wallet.publicKey))
  const state = { address: addresses.user.toBase58(), nextSequence: 1n, authorityRevision: 0n, profileReference: '00'.repeat(32) }
  const reference = await sha256(new TextEncoder().encode('new profile'))
  const update = await profileTransaction(auth, wallet.publicKey, state, reference, 1800000000n)
  const updateProof = update.instructions[0].data
  assert(verify('sha256', updateProof.subarray(113), { key, dsaEncoding: 'ieee-p1363' }, updateProof.subarray(16, 80)))
  assert(update.instructions[1].keys[0].pubkey.equals(wallet.publicKey))
  assert.equal(hex(update.instructions[1].data.subarray(8, 40)), hex(reference))
  await assert.rejects(() => profileTransaction(auth, wallet.publicKey, { ...state, address: Keypair.generate().publicKey.toBase58() }, reference, 1800000000n), /does not match/)
  await assert.rejects(() => profileTransaction(auth, wallet.publicKey, state, bytes([1]), 1800000000n), /32 bytes/)
  await assert.rejects(() => profileTransaction(auth, wallet.publicKey, { ...state, nextSequence: -1n }, reference, 1800000000n), /sequence or expiry/)
})

test('on-chain readback rejects missing, unrelated, or inactive account links', async () => {
  const auth = await authenticator(await newCredential())
  const wallet = Keypair.generate().publicKey
  const { user, credentialHash } = await accountAddresses(auth, wallet)
  const account = Buffer.alloc(102), link = Buffer.alloc(74), passkey = Buffer.alloc(107)
  for (const [name, data] of [['UserAccount', account], ['WalletLink', link], ['PasskeyLink', passkey]] as const) Buffer.from(await sha256(new TextEncoder().encode(`account:${name}`))).copy(data, 0, 0, 8)
  account[8] = 1; Buffer.from(auth.userId).copy(account, 9); account.writeBigUInt64LE(1n, 61)
  user.toBuffer().copy(link, 8); wallet.toBuffer().copy(link, 40); link[72] = 1
  user.toBuffer().copy(passkey, 8); Buffer.from(credentialHash).copy(passkey, 40); Buffer.from(auth.publicKey).copy(passkey, 72); passkey[105] = 1
  let response: unknown[] = [account, link, passkey].map(data => ({ data, owner: USER_ACCOUNT_PROGRAM }))
  const connection = { getMultipleAccountsInfo: async () => response } as any
  assert.equal((await fetchUserAccount(connection, auth, wallet))!.nextSequence, 1n)
  link[72] = 0
  await assert.rejects(() => fetchUserAccount(connection, auth, wallet), /active account links/)
  link[72] = 1; passkey[72] ^= 1
  await assert.rejects(() => fetchUserAccount(connection, auth, wallet), /active account links/)
  response = [{ data: account, owner: SystemProgramId() }, null, null]
  await assert.rejects(() => fetchUserAccount(connection, auth, wallet), /invalid owner/)
  response = [null, null, null]
  assert.equal(await fetchUserAccount(connection, auth, wallet), null)
})
function SystemProgramId() { return new PublicKey('11111111111111111111111111111111') }

test('HTTP transaction confirmation rejects failures, expiry, and uncertain outcomes', async () => {
  const latest = { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }
  const connection = (status: unknown, height = 50) => ({
    getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => height,
  }) as any
  await confirmWalletTransaction(connection({ confirmationStatus: 'confirmed', err: null }), 'signature', latest)
  await assert.rejects(() => confirmWalletTransaction(connection({ err: { InstructionError: [0, 'error'] } }), 'signature', latest), /Transaction failed/)
  await assert.rejects(() => confirmWalletTransaction(connection(null, 101), 'signature', latest), /expired before confirmation/)
  await assert.rejects(() => confirmWalletTransaction(connection(null), 'signature', latest, 0), /confirmation timed out/)
  await assert.rejects(() => confirmWalletTransaction(connection(null), '', latest), /Missing transaction signature/)
  const failedRpc = { getSignatureStatuses: async () => { throw new Error('RPC unavailable') } } as any
  await assert.rejects(() => confirmWalletTransaction(failedRpc, 'signature', latest), /RPC unavailable/)
})

test('account setup requires an executable program and a known chain time', async () => {
  const wallet = Keypair.generate().publicKey
  for (const program of [null, { executable: false }]) {
    const connection = { getAccountInfo: async () => program } as any
    await assert.rejects(() => accountChainContext(connection, wallet), /Deploy the UserAccount testing program/)
  }
  const connection = { getAccountInfo: async () => ({ executable: true }), getGenesisHash: async () => 'test-genesis' } as any
  assert.equal(await accountChainContext(connection, wallet), credentialStorageKey('test-genesis', wallet))
  await assert.rejects(() => approvalExpiry({ getSlot: async () => 1, getBlockTime: async () => null } as any), /block time is unavailable/)
  assert.equal(await approvalExpiry({ getSlot: async () => 1, getBlockTime: async () => 1800000000 } as any), 1800000240n)
})
