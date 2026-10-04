import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createPasskeyMock, clientData, sha256 } from './passkey-mock.mjs';
import { addresses, creationPayload, prepareCreation, passkeyInstruction, requireLocalnet, createInstruction } from './client.mjs';

const fixture = () => ({ userId: randomBytes(32), wallet: Keypair.generate().publicKey, payer: Keypair.generate().publicKey, mock: createPasskeyMock(), expiresAt: 1800000000 });

test('mock generates valid WebAuthn ES256 proof and rejects tampered bytes', () => {
  const mock = createPasskeyMock();
  const proof = mock.assert(sha256(Buffer.from('test')));
  assert.equal(mock.registrationAuthenticatorData.length, 164);
  assert.equal(mock.verify(proof.message, proof.signature), true);
  const changed = Buffer.from(proof.message); changed[0] ^= 1;
  assert.equal(mock.verify(changed, proof.signature), false);
  assert.equal(JSON.parse(proof.clientDataJson).crossOrigin, false);
});
test('canonical bootstrap binds wallet, sponsor, identity, key, credential and expiry', () => {
  const input = fixture();
  const original = creationPayload(input);
  for (const change of [{ wallet: Keypair.generate().publicKey }, { payer: Keypair.generate().publicKey }, { userId: randomBytes(32) }, { mock: createPasskeyMock() }, { expiresAt: input.expiresAt + 1 }]) {
    assert.notDeepEqual(creationPayload({ ...input, ...change }), original);
  }
  const prepared = prepareCreation(input);
  assert.equal(input.mock.verify(prepared.assertion.message, prepared.assertion.signature), true);
  const instruction = passkeyInstruction(input.mock.publicKey, prepared.assertion);
  assert.equal(instruction.data.length, 182);
  assert.equal(instruction.data.readUInt16LE(4), 0xffff);
  assert.deepEqual(instruction.data.subarray(113), prepared.assertion.message);
});
test('stable identity survives wallet and credential selection', () => {
  const input = fixture();
  assert(addresses(input.userId, input.wallet, input.mock.credentialId).user.equals(addresses(input.userId, Keypair.generate().publicKey, randomBytes(32)).user));
});
test('reject unsupported RPCs and malformed proof inputs explicitly', async () => {
  for (const url of ['https://api.devnet.solana.com', 'http://localhost.evil.com', 'http://user:secret@localhost:8899', 'file:///tmp/rpc']) {
    assert.throws(() => requireLocalnet(url), /loopback localnet/);
  }
  assert.throws(() => requireLocalnet('invalid'), /Invalid URL/);
  assert.equal(requireLocalnet('http://127.0.0.1:8899'), 'http://127.0.0.1:8899/');
  assert.throws(() => addresses(Buffer.alloc(31), fixture().wallet, Buffer.alloc(32)), /User ID must be 32 bytes/);
  assert.throws(() => addresses(Buffer.alloc(32), fixture().wallet, Buffer.alloc(31)), /Credential ID must be 32 bytes/);
  assert.throws(() => creationPayload({ ...fixture(), expiresAt: NaN }), /Expiry must/);
  assert.throws(() => clientData('invalid', Buffer.alloc(32)), /Unsupported WebAuthn type/);
  assert.throws(() => clientData('webauthn.get', Buffer.alloc(0)), /Challenge must/);
  assert.throws(() => passkeyInstruction(Buffer.alloc(33), {}), /compressed P-256/);
  const mock = createPasskeyMock();
  assert.throws(() => passkeyInstruction(mock.publicKey, { signature: Buffer.alloc(63), message: Buffer.alloc(69) }), /64-byte signature/);
  await assert.rejects(() => createInstruction({ programId: Keypair.generate().publicKey }, {}, fixture().payer, fixture().wallet), /Unexpected UserAccount program ID/);
});

test('canonical payload matches Rust vector', () => {
  const input = { userId: Buffer.alloc(32, 5), wallet: new PublicKey(Buffer.alloc(32, 3)), payer: new PublicKey(Buffer.alloc(32, 4)), mock: { credentialId: Buffer.alloc(32, 7), publicKey: Buffer.alloc(33, 6) }, expiresAt: 1800000000 };
  assert.equal(sha256(creationPayload(input)).toString('hex'), '8fab4fcf9ff82da0831b6b250208b87f73e0ce45019c8d35447f83091555d58b');
});
