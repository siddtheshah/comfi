import { Buffer } from 'buffer'
import { Connection, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'

export const USER_ACCOUNT_PROGRAM = new PublicKey('7FHwv2r8R8avPiqq7ZaAUx3XYozt36F1zFfoNMHZeJ57')
const R1_PROGRAM = new PublicKey('Secp256r1SigVerify1111111111111111111111111')
const encoder = new TextEncoder()
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const ITERATIONS = 600_000
type Bytes = Uint8Array<ArrayBuffer>
export const bytes = (input: ArrayLike<number>): Bytes => Uint8Array.from(input)
export const concat = (...parts: Uint8Array[]): Bytes => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
export const hex = (input: Uint8Array): string => Array.from(input, value => value.toString(16).padStart(2, '0')).join('')
export function unhex(input: string, length?: number): Bytes {
  if (typeof input !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(input) || (length !== undefined && input.length !== length * 2)) throw new Error('Invalid account credential encoding.')
  return bytes(input.match(/../g)!.map(value => parseInt(value, 16)))
}
export const sha256 = async (input: Uint8Array): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(input)))
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i])
const random = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length))
const u64 = (value: bigint): Bytes => {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error('Invalid account sequence or expiry.')
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, value, true)
  return result
}
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const fromBase64url = (value: string) => bytes(Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)))

export function requireAccountWallet(network: string, endpoint: string, walletMode: string, wallet?: string): PublicKey {
  const url = new URL(endpoint)
  if (network !== 'localnet' || !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('User accounts currently require a localnet RPC.')
  if (!wallet || !['in-browser', 'phantom', 'backpack'].includes(walletMode)) throw new Error('Connect a base wallet: ComFi Wallet, Phantom, or Backpack.')
  return new PublicKey(wallet)
}

export type Credential = { userId: string; credentialId: string; privateKey: JsonWebKey }
export type EncryptedCredential = { version: 1; salt: string; iv: string; ciphertext: string }
export type Authenticator = { privateKey: CryptoKey; publicKey: Bytes; credentialId: Bytes; registration: Bytes; userId: Bytes }
export function credentialStorageKey(genesis: string, wallet: PublicKey): string {
  return `comfi:user-account:v1:${USER_ACCOUNT_PROGRAM.toBase58()}:${genesis}:${wallet.toBase58()}`
}
function requirePasscode(passcode: string) {
  if (typeof passcode !== 'string' || passcode.length < 8 || passcode.length > 128) throw new Error('Use a browser passcode of 8–128 characters.')
}
async function encryptionKey(passcode: string, salt: Bytes): Promise<CryptoKey> {
  requirePasscode(passcode)
  const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function sealCredential(credential: Credential, passcode: string, context: string): Promise<EncryptedCredential> {
  const salt = random(16), iv = random(12)
  const key = await encryptionKey(passcode, salt)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(credential)))
  return { version: 1, salt: hex(salt), iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)) }
}
export function parseCredentialRecord(raw: string): EncryptedCredential {
  const record = JSON.parse(raw) as EncryptedCredential
  if (record?.version !== 1) throw new Error('Unsupported account credential. The saved credential has been preserved.')
  unhex(record.salt, 16); unhex(record.iv, 12)
  const ciphertext = unhex(record.ciphertext)
  if (ciphertext.length < 16 || ciphertext.length > 4096) throw new Error('Invalid encrypted account credential.')
  return record
}
export function parseCredentialBackup(raw: string, context: string): EncryptedCredential {
  const backup = JSON.parse(raw) as { storageKey: string; credential: unknown }
  if (backup?.storageKey !== context) throw new Error('This backup belongs to a different base wallet or localnet.')
  return parseCredentialRecord(JSON.stringify(backup.credential))
}
export async function openCredential(record: EncryptedCredential, passcode: string, context: string): Promise<Credential> {
  // Reject malformed storage separately; never replace it with a new identity.
  parseCredentialRecord(JSON.stringify(record))
  const key = await encryptionKey(passcode, unhex(record.salt, 16))
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(record.iv, 12), additionalData: encoder.encode(context) }, key, unhex(record.ciphertext))
  } catch {
    throw new Error('Incorrect passcode or damaged account credential. Nothing was changed.')
  }
  const credential = JSON.parse(new TextDecoder().decode(plaintext)) as Credential
  unhex(credential.userId, 32); unhex(credential.credentialId, 32)
  if (!credential.privateKey?.d || credential.privateKey.crv !== 'P-256' || credential.privateKey.kty !== 'EC') throw new Error('Invalid saved authenticator key.')
  return credential
}
export async function newCredential(): Promise<Credential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return { userId: hex(random(32)), credentialId: hex(random(32)), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}
export async function authenticator(credential: Credential): Promise<Authenticator> {
  const privateKey = await crypto.subtle.importKey('jwk', credential.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const x = fromBase64url(credential.privateKey.x!), y = fromBase64url(credential.privateKey.y!)
  if (x.length !== 32 || y.length !== 32) throw new Error('Invalid saved authenticator public key.')
  const credentialId = unhex(credential.credentialId, 32)
  const publicKey = concat(bytes([2 | (y[31] & 1)]), x)
  const cose = concat(bytes([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]), x, bytes([0x22, 0x58, 0x20]), y)
  const registration = concat(await sha256(encoder.encode('localhost')), bytes([0x45]), new Uint8Array(20), bytes([0, 32]), credentialId, cose)
  return { privateKey, publicKey, credentialId, registration, userId: unhex(credential.userId, 32) }
}
export async function accountAddresses(auth: Authenticator, wallet: PublicKey) {
  const credentialHash = await sha256(auth.credentialId)
  const [user] = PublicKey.findProgramAddressSync([encoder.encode('user'), auth.userId], USER_ACCOUNT_PROGRAM)
  const [walletLink] = PublicKey.findProgramAddressSync([encoder.encode('wallet'), user.toBytes(), wallet.toBytes()], USER_ACCOUNT_PROGRAM)
  const [passkey] = PublicKey.findProgramAddressSync([encoder.encode('passkey'), user.toBytes(), credentialHash], USER_ACCOUNT_PROGRAM)
  return { user, walletLink, passkey, credentialHash }
}
export async function clientData(kind: 'webauthn.get' | 'webauthn.create', challenge: Bytes): Promise<Bytes> {
  return encoder.encode(JSON.stringify({ type: kind, challenge: base64url(challenge), origin: 'http://localhost:5173', crossOrigin: false }))
}
export async function assertion(auth: Authenticator, challenge: Bytes) {
  const json = await clientData('webauthn.get', challenge)
  const data = concat(await sha256(encoder.encode('localhost')), bytes([0x05]), new Uint8Array(4))
  const message = concat(data, await sha256(json))
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, auth.privateKey, message))
  const s = BigInt(`0x${hex(signature.subarray(32))}`)
  if (s > P256_ORDER / 2n) signature.set(unhex((P256_ORDER - s).toString(16).padStart(64, '0'), 32), 32)
  const header = new Uint8Array(16); header[0] = 1
  const view = new DataView(header.buffer)
  ;[16, 65535, 80, 65535, 113, message.length, 65535].forEach((value, index) => view.setUint16(2 + index * 2, value, true))
  return { json, data, proof: new TransactionInstruction({ programId: R1_PROGRAM, keys: [], data: Buffer.from(concat(header, signature, auth.publicKey, message)) }) }
}
async function domain(action: string): Promise<Bytes> {
  return concat(encoder.encode(`comfi:user-account:${action}:v1\0`), USER_ACCOUNT_PROGRAM.toBytes(), await sha256(encoder.encode('comfi:standalone:localnet:v1')))
}
const vector = (value: Bytes): Bytes => {
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, value.length, true)
  return concat(length, value)
}
const discriminator = async (name: string): Promise<Bytes> => (await sha256(encoder.encode(`global:${name}`))).slice(0, 8)
export async function creationTransaction(auth: Authenticator, wallet: PublicKey, expiresAt: bigint): Promise<Transaction> {
  const { user, walletLink, passkey, credentialHash } = await accountAddresses(auth, wallet)
  const payload = concat(await domain('create'), user.toBytes(), wallet.toBytes(), wallet.toBytes(), auth.userId, auth.publicKey, credentialHash,
    await sha256(encoder.encode('localhost')), await sha256(encoder.encode('http://localhost:5173')), bytes([1, 0]), new Uint8Array(16), u64(expiresAt))
  const registrationClient = await clientData('webauthn.create', await sha256(payload))
  const challenge = await sha256(concat(encoder.encode('comfi:user-account:possession:v1\0'), payload, await sha256(auth.registration), await sha256(registrationClient)))
  const signed = await assertion(auth, challenge)
  return new Transaction().add(signed.proof, new TransactionInstruction({ programId: USER_ACCOUNT_PROGRAM,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: true }, { pubkey: walletLink, isSigner: false, isWritable: true },
      { pubkey: passkey, isSigner: false, isWritable: true }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: Buffer.from(concat(await discriminator('create_user'), auth.userId, u64(expiresAt), credentialHash, auth.registration, signed.data, vector(signed.json))),
  }))
}
export type AccountState = { address: string; nextSequence: bigint; authorityRevision: bigint; profileReference: string }
export async function profileTransaction(auth: Authenticator, wallet: PublicKey, state: AccountState, reference: Bytes, expiresAt: bigint): Promise<Transaction> {
  if (reference.length !== 32) throw new Error('Profile reference must be 32 bytes.')
  const { user, walletLink, passkey, credentialHash } = await accountAddresses(auth, wallet)
  if (state.address !== user.toBase58()) throw new Error('UserAccount does not match the unlocked credential.')
  const payload = concat(await domain('update-profile'), user.toBytes(), wallet.toBytes(), credentialHash, reference,
    u64(state.authorityRevision), u64(state.nextSequence), u64(expiresAt))
  const signed = await assertion(auth, await sha256(payload))
  return new Transaction().add(signed.proof, new TransactionInstruction({ programId: USER_ACCOUNT_PROGRAM,
    keys: [ { pubkey: wallet, isSigner: true, isWritable: false }, { pubkey: user, isSigner: false, isWritable: true },
      { pubkey: walletLink, isSigner: false, isWritable: false }, { pubkey: passkey, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false } ],
    data: Buffer.from(concat(await discriminator('update_profile'), reference, u64(state.nextSequence), u64(expiresAt), signed.data, vector(signed.json))),
  }))
}
export async function fetchUserAccount(connection: Connection, auth: Authenticator, wallet: PublicKey): Promise<AccountState | null> {
  const { user, walletLink, passkey, credentialHash } = await accountAddresses(auth, wallet)
  const [account, link, key] = await connection.getMultipleAccountsInfo([user, walletLink, passkey], 'confirmed')
  if (!account && !link && !key) return null
  if (!account || !link || !key || ![account, link, key].every(value => value.owner.equals(USER_ACCOUNT_PROGRAM))) throw new Error('UserAccount or credential links are missing or have an invalid owner.')
  const accountTag = (await sha256(encoder.encode('account:UserAccount'))).subarray(0, 8)
  if (account.data.length !== 102 || !equal(account.data.subarray(0, 8), accountTag) || account.data[8] !== 1 ||
    !equal(account.data.subarray(9, 41), auth.userId)) throw new Error('Unsupported UserAccount layout.')
  const walletTag = (await sha256(encoder.encode('account:WalletLink'))).subarray(0, 8)
  const passkeyTag = (await sha256(encoder.encode('account:PasskeyLink'))).subarray(0, 8)
  if (link.data.length !== 74 || !equal(link.data.subarray(0, 8), walletTag) || !equal(link.data.subarray(8, 40), user.toBytes()) ||
    !equal(link.data.subarray(40, 72), wallet.toBytes()) || link.data[72] !== 1 || key.data.length !== 107 ||
    !equal(key.data.subarray(0, 8), passkeyTag) || !equal(key.data.subarray(8, 40), user.toBytes()) ||
    !equal(key.data.subarray(40, 72), credentialHash) || !equal(key.data.subarray(72, 105), auth.publicKey) || key.data[105] !== 1) throw new Error('Base wallet or authenticator does not match the active account links.')
  return { address: user.toBase58(), nextSequence: new DataView(bytes(account.data).buffer).getBigUint64(61, true), authorityRevision: new DataView(bytes(account.data).buffer).getBigUint64(45, true), profileReference: hex(account.data.subarray(69, 101)) }
}
export async function accountChainContext(connection: Connection, wallet: PublicKey): Promise<string> {
  const program = await connection.getAccountInfo(USER_ACCOUNT_PROGRAM, 'confirmed')
  if (!program?.executable) throw new Error('Deploy the UserAccount testing program to this localnet before creating an account.')
  return credentialStorageKey(await connection.getGenesisHash(), wallet)
}
export async function approvalExpiry(connection: Connection): Promise<bigint> {
  const slot = await connection.getSlot('confirmed')
  const time = await connection.getBlockTime(slot)
  if (time === null) throw new Error('Localnet block time is unavailable. Retry when the validator is ready.')
  return BigInt(time + 240)
}
