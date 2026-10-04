import { PublicKey, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { clientData, sha256, RP_ID, ORIGIN } from './passkey-mock.mjs';

export const PROGRAM_ID = new PublicKey('7FHwv2r8R8avPiqq7ZaAUx3XYozt36F1zFfoNMHZeJ57');
export const R1_PROGRAM_ID = new PublicKey('Secp256r1SigVerify1111111111111111111111111');
const CLUSTER_DOMAIN = Buffer.from('comfi:standalone:localnet:v1');

export function requireLocalnet(rpcUrl) {
  const url = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('UserAccount scripts require a loopback localnet RPC URL');
  }
  return url.toString();
}

export function addresses(userId, wallet, credentialId) {
  if (!Buffer.isBuffer(userId) || userId.length !== 32) throw new Error('User ID must be 32 bytes');
  if (!Buffer.isBuffer(credentialId) || credentialId.length !== 32) throw new Error('Credential ID must be 32 bytes');
  const [user] = PublicKey.findProgramAddressSync([Buffer.from('user'), userId], PROGRAM_ID);
  const [walletLink] = PublicKey.findProgramAddressSync([Buffer.from('wallet'), user.toBuffer(), wallet.toBuffer()], PROGRAM_ID);
  const [passkey] = PublicKey.findProgramAddressSync([Buffer.from('passkey'), user.toBuffer(), sha256(credentialId)], PROGRAM_ID);
  return { user, walletLink, passkey };
}

export function creationPayload({ userId, wallet, payer, mock, expiresAt }) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new Error('Expiry must be a nonnegative integer timestamp');
  const { user } = addresses(userId, wallet, mock.credentialId);
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(BigInt(expiresAt));
  return Buffer.concat([
    Buffer.from('comfi:user-account:create:v1\0'), PROGRAM_ID.toBuffer(), sha256(CLUSTER_DOMAIN),
    user.toBuffer(), wallet.toBuffer(), payer.toBuffer(), userId, mock.publicKey, sha256(mock.credentialId),
    sha256(Buffer.from(RP_ID)), sha256(Buffer.from(ORIGIN)), Buffer.from([1, 0]), Buffer.alloc(16), expiry,
  ]);
}

export function prepareCreation(input) {
  const payload = creationPayload(input);
  const registrationClientData = clientData('webauthn.create', sha256(payload));
  const challenge = sha256(Buffer.concat([
    Buffer.from('comfi:user-account:possession:v1\0'), payload,
    sha256(input.mock.registrationAuthenticatorData), sha256(registrationClientData),
  ]));
  const assertion = input.mock.assert(challenge);
  return {
    ...addresses(input.userId, input.wallet, input.mock.credentialId),
    assertion,
    args: {
      userId: [...input.userId], expiresAt: new BN(input.expiresAt), credentialHash: [...sha256(input.mock.credentialId)],
      registrationAuthenticatorData: [...input.mock.registrationAuthenticatorData],
      assertionAuthenticatorData: [...assertion.authenticatorData],
      clientDataJson: assertion.clientDataJson,
    },
  };
}

export function passkeyInstruction(publicKey, assertion) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 33 || ![2, 3].includes(publicKey[0])) throw new Error('Expected compressed P-256 key');
  if (!Buffer.isBuffer(assertion.signature) || assertion.signature.length !== 64 || !Buffer.isBuffer(assertion.message) || assertion.message.length !== 69) {
    throw new Error('Expected a 64-byte signature and 69-byte WebAuthn message');
  }
  const header = Buffer.alloc(16);
  header[0] = 1;
  [16, 0xffff, 80, 0xffff, 113, assertion.message.length, 0xffff].forEach((value, index) => header.writeUInt16LE(value, 2 + index * 2));
  return new TransactionInstruction({ programId: R1_PROGRAM_ID, keys: [], data: Buffer.concat([header, assertion.signature, publicKey, assertion.message]) });
}

export async function createInstruction(program, prepared, payer, wallet) {
  if (!program.programId.equals(PROGRAM_ID)) throw new Error('Unexpected UserAccount program ID');
  return program.methods.createUser(prepared.args).accountsStrict({
    payer, wallet, user: prepared.user, walletLink: prepared.walletLink, passkey: prepared.passkey,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId,
  }).instruction();
}
