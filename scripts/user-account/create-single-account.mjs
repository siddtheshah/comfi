import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createPasskeyMock, sha256 } from './passkey-mock.mjs';
import { PROGRAM_ID, prepareCreation, passkeyInstruction, createInstruction, requireLocalnet } from './client.mjs';

const options = new Map();
for (const arg of process.argv.slice(2)) {
  if (['--negative-tests', '--expect-disabled'].includes(arg)) { options.set(arg.slice(2), true); continue; }
  const match = /^--(rpc-url|payer)=(.+)$/.exec(arg);
  if (!match || options.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${arg}`);
  options.set(match[1], match[2]);
}
const rpcUrl = requireLocalnet(options.get('rpc-url') ?? 'http://127.0.0.1:18899');
if (!options.get('payer')) throw new Error('Missing --payer=<localnet payer keypair path>');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(options.get('payer'), 'utf8'))));
const connection = new Connection(rpcUrl, 'confirmed');
const idl = JSON.parse(await readFile(fileURLToPath(new URL('../../target/idl/user_account.json', import.meta.url)), 'utf8'));
assert.equal(idl.address, PROGRAM_ID.toBase58(), 'IDL program ID mismatch');
const deployed = await connection.getAccountInfo(PROGRAM_ID);
assert(deployed?.executable, 'Standalone UserAccount program is not deployed');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
assert(deployed.owner.equals(loader), 'Unexpected program loader');
const [programDataAddress] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], loader);
assert.deepEqual(deployed.data.subarray(4, 36), programDataAddress.toBuffer(), 'Noncanonical ProgramData address');
const programData = await connection.getAccountInfo(programDataAddress);
assert(programData?.owner.equals(loader) && programData.data.length > 45, 'Missing ProgramData');
const binary = await readFile(fileURLToPath(new URL('../../target/deploy/user_account.so', import.meta.url)));
assert.deepEqual(programData.data.subarray(45, 45 + binary.length), binary, 'Deployed code differs from built binary');
// Upgradeable-loader visibility is delayed after deployment. Wait for a later
// confirmed slot instead of treating an unactivated program as a policy failure.
const deployedSlot = Number(programData.data.readBigUInt64LE(4));
const activationDeadline = Date.now() + 30_000;
while (await connection.getSlot('confirmed') <= deployedSlot + 1) {
  if (Date.now() > activationDeadline) throw new Error('Program activation timed out');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const wallet = Keypair.generate();
const mock = createPasskeyMock();
const slot = await connection.getSlot();
const chainTime = await connection.getBlockTime(slot);
assert.notEqual(chainTime, null, 'Localnet block time unavailable');
const input = { userId: randomBytes(32), wallet: wallet.publicKey, payer: payer.publicKey, mock, expiresAt: chainTime + 240 };
const prepared = prepareCreation(input);
const checks = [];
let transactionSequence = 0;
let lastTransactionBytes = 0;

async function send(candidate = prepared, proofKey = mock.publicKey, signers = [payer, wallet], includeProof = true, targetWallet = wallet.publicKey) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++transactionSequence }));
  if (includeProof) tx.add(passkeyInstruction(proofKey, candidate.assertion));
  tx.add(await createInstruction(program, candidate, payer.publicKey, targetWallet));
  tx.feePayer = payer.publicKey;
  // Serialization here is an explicit Solana 1232-byte packet-budget check.
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  if (signers.some((signer) => signer.publicKey.equals(wallet.publicKey))) {
    assert(tx.serialize().length <= 1232, 'Bootstrap exceeds Solana packet budget');
  }
  lastTransactionBytes = tx.serialize().length;
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  // HTTP polling keeps this localnet script usable in proxy environments where
  // the SDK's websocket subscriptions are unavailable. RPC failures propagate.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status) {
      assert.equal(status.err, null, `Transaction failed: ${JSON.stringify(status.err)}`);
      if (['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature;
    }
    if (await connection.getBlockHeight('confirmed') > latest.lastValidBlockHeight) throw new Error('Transaction blockhash expired');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Transaction confirmation timed out: ${signature}`);
}
async function unchanged() {
  const state = await connection.getMultipleAccountsInfo([prepared.user, prepared.walletLink, prepared.passkey]);
  assert.deepEqual(state, [null, null, null], 'Rejected creation must not initialize any account');
}
async function rejectCreation(name, candidate, pattern, ...rest) {
  await assert.rejects(() => send(candidate, ...rest), pattern);
  await unchanged();
  checks.push(name);
  console.log(`Rejected as expected: ${name}`);
}
const withArgs = (args) => ({ ...prepared, args: { ...prepared.args, ...args } });

if (options.get('expect-disabled')) {
  await rejectCreation('production bootstrap disabled', prepared, /LocalnetOnly/);
  console.log('Production bootstrap rejected; no accounts initialized.');
  process.exit(0);
}

if (options.get('negative-tests')) {
  await rejectCreation('missing passkey proof', prepared, /MissingPasskeyProof/, mock.publicKey, [payer, wallet], false);
  await rejectCreation('missing wallet signature', prepared, /Signature verification failed|Missing signature/, mock.publicKey, [payer]);
  const otherWallet = Keypair.generate();
  // A valid proof for another signing wallet must not bootstrap this account.
  const forOtherWallet = prepareCreation({ ...input, wallet: otherWallet.publicKey });
  await rejectCreation('wallet substitution', { ...prepared, args: forOtherWallet.args, assertion: forOtherWallet.assertion }, /InvalidClientData/);
  const otherPayer = Keypair.generate().publicKey;
  const forOtherPayer = prepareCreation({ ...input, payer: otherPayer });
  await rejectCreation('fee-payer substitution', { ...prepared, args: forOtherPayer.args, assertion: forOtherPayer.assertion }, /InvalidClientData/);
  const noUv = [...prepared.args.assertionAuthenticatorData]; noUv[32] = 1;
  await rejectCreation('user verification required', withArgs({ assertionAuthenticatorData: noUv }), /InvalidFlags/);
  const wrongRp = [...prepared.args.assertionAuthenticatorData]; wrongRp[0] ^= 1;
  await rejectCreation('wrong RP ID', withArgs({ assertionAuthenticatorData: wrongRp }), /InvalidRpId/);
  const registration = [...prepared.args.registrationAuthenticatorData]; registration[89] = 3;
  await rejectCreation('unsupported registration algorithm', withArgs({ registrationAuthenticatorData: registration }), /InvalidRegistration/);
  const malformedPoint = [...prepared.args.registrationAuthenticatorData]; malformedPoint.fill(0, 97, 129); malformedPoint.fill(0, 132, 164);
  await rejectCreation('invalid registration curve point', withArgs({ registrationAuthenticatorData: malformedPoint }), /InvalidRegistration/);
  for (const [name, change] of [
    ['wrong origin', { origin: 'https://evil.example' }], ['wrong challenge', { challenge: Buffer.alloc(32).toString('base64url') }],
    ['wrong WebAuthn type', { type: 'webauthn.create' }], ['cross-origin assertion', { crossOrigin: true }],
  ]) {
    const json = Buffer.from(JSON.stringify({ ...JSON.parse(prepared.args.clientDataJson), ...change }));
    await rejectCreation(name, withArgs({ clientDataJson: json }), /InvalidClientData/);
  }
  const expired = prepareCreation({ ...input, expiresAt: chainTime - 1 });
  await rejectCreation('expired approval', expired, /InvalidExpiry/);
  const excessive = prepareCreation({ ...input, expiresAt: chainTime + 3600 });
  await rejectCreation('overlong approval', excessive, /InvalidExpiry/);
  const otherMock = createPasskeyMock();
  const otherProof = otherMock.assert(sha256(Buffer.from('unrelated')));
  await rejectCreation('unrelated valid signature', { ...prepared, assertion: otherProof }, /InvalidPasskeyProof/, otherMock.publicKey);
  const damaged = Buffer.from(prepared.assertion.signature); damaged[0] ^= 1;
  await rejectCreation('invalid cryptographic signature', { ...prepared, assertion: { ...prepared.assertion, signature: damaged } }, /custom program error: 0x2|precompile|signature|Signature|Verification|verify/);
}

const signature = await send();
const transactionBytes = lastTransactionBytes;
const receipt = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
assert(receipt?.meta && receipt.meta.err === null, 'Missing successful transaction receipt');
assert(receipt.meta.computeUnitsConsumed > 0 && receipt.meta.computeUnitsConsumed <= 200_000, 'Bootstrap exceeds the default compute budget');
const user = await program.account.userAccount.fetch(prepared.user);
const link = await program.account.walletLink.fetch(prepared.walletLink);
const passkey = await program.account.passkeyLink.fetch(prepared.passkey);
assert.equal(user.version, 1);
assert.deepEqual(Buffer.from(user.userId), input.userId);
assert.equal(user.walletCount, 1);
assert.equal(user.passkeyCount, 1);
assert.equal(user.authorityRevision.toString(), '0');
assert.equal(user.walletLinkRevision.toString(), '0');
assert.equal(user.nextSequence.toString(), '1');
assert.deepEqual(Buffer.from(user.profileReference), Buffer.alloc(32));
assert(link.user.equals(prepared.user) && link.wallet.equals(wallet.publicKey) && link.active);
assert(passkey.user.equals(prepared.user) && passkey.active);
assert.deepEqual(Buffer.from(passkey.publicKey), mock.publicKey);
assert.deepEqual(Buffer.from(passkey.credentialHash), sha256(mock.credentialId));
assert.notEqual(wallet.publicKey.toBase58(), payer.publicKey.toBase58());
assert.equal(await connection.getBalance(wallet.publicKey), 0, 'Unfunded wallet signs; sponsor pays fees/rent');
const states = await connection.getMultipleAccountsInfo([prepared.user, prepared.walletLink, prepared.passkey]);
for (const state of states) assert(state.owner.equals(PROGRAM_ID), 'Unexpected account owner');
if (options.get('negative-tests')) {
  await assert.rejects(() => send(), /already in use/);
  assert.equal((await program.account.userAccount.fetch(prepared.user)).nextSequence.toString(), '1');
  checks.push('duplicate bootstrap replay');
}
console.log(JSON.stringify({ rpcUrl, programId: PROGRAM_ID.toBase58(), user: prepared.user.toBase58(), wallet: wallet.publicKey.toBase58(), payer: payer.publicKey.toBase58(), walletLink: prepared.walletLink.toBase58(), passkey: prepared.passkey.toBase58(), signature, transactionBytes, computeUnitsConsumed: receipt.meta.computeUnitsConsumed, negativeChecks: checks, disposableAuthenticator: true }, null, 2));
