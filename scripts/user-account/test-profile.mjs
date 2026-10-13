// Exercise the same passcode authenticator/client used by the UI on real localnet.
import assert from 'node:assert/strict';
import { Connection, Keypair } from '@solana/web3.js';
import { requireLocalnet } from './client.mjs';
import {
  authenticator, approvalExpiry, creationTransaction, fetchUserAccount, hex,
  newCredential, openCredential, profileTransaction, sealCredential, sha256,
} from '../../apps/web/src/user-account.ts';

const rpcUrl = requireLocalnet(process.argv[2] ?? 'http://127.0.0.1:18899');
const connection = new Connection(rpcUrl, 'confirmed');
const wallet = Keypair.generate();
const funded = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
async function confirm(signature, latest) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status) {
      assert.equal(status.err, null, `Transaction failed: ${JSON.stringify(status.err)}`);
      if (['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature;
    }
    if (latest && await connection.getBlockHeight('confirmed') > latest.lastValidBlockHeight) throw new Error('Transaction blockhash expired');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Transaction confirmation timed out');
}
await confirm(funded);
async function send(transaction, signers = [wallet]) {
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(...signers);
  assert(transaction.serialize().length <= 1232, 'Account transaction exceeds packet budget');
  return confirm(await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' }), latest);
}
const credential = await newCredential();
const encrypted = await sealCredential(credential, 'test browser passcode', 'profile-workflow');
await assert.rejects(() => openCredential(encrypted, 'incorrect passcode', 'profile-workflow'), /Incorrect passcode/);
const auth = await authenticator(await openCredential(encrypted, 'test browser passcode', 'profile-workflow'));
const created = await send(await creationTransaction(auth, wallet.publicKey, await approvalExpiry(connection)));
const before = await fetchUserAccount(connection, auth, wallet.publicKey);
assert(before && before.nextSequence === 1n);
const reference = await sha256(new TextEncoder().encode('Profile update from the browser client'));
const update = () => profileTransaction(auth, wallet.publicKey, before, reference, approvalTime);
const approvalTime = await approvalExpiry(connection);
const rejected = [];
async function reject(name, transaction, pattern, signers) {
  await assert.rejects(() => send(transaction, signers), pattern);
  assert.deepEqual(await fetchUserAccount(connection, auth, wallet.publicKey), before, 'Rejected update changed account state');
  rejected.push(name);
}
const noProof = await update(); noProof.instructions.shift();
await reject('missing authenticator proof', noProof, /MissingPasskeyProof/);
const changed = await update(); changed.instructions[1].data[8] ^= 1;
await reject('profile field substitution', changed, /InvalidClientData/);
await reject('expired approval', await profileTransaction(auth, wallet.publicKey, before, reference, approvalTime - 1000n), /InvalidExpiry/);
await reject('wrong sequence', await profileTransaction(auth, wallet.publicKey, { ...before, nextSequence: 0n }, reference, approvalTime), /InvalidSequence/);
const damaged = await update(); damaged.instructions[0].data[16] ^= 1;
await reject('invalid P-256 signature', damaged, /custom program error|signature|Signature|Verification|verify/);
const other = await authenticator({ ...await newCredential(), userId: credential.userId, credentialId: credential.credentialId });
await reject('unrelated authenticator', await profileTransaction(other, wallet.publicKey, before, reference, approvalTime), /InvalidPasskeyProof/);
const differentWallet = Keypair.generate();
const wrongWallet = await update(); wrongWallet.instructions[1].keys[0].pubkey = differentWallet.publicKey;
await reject('unlinked base wallet', wrongWallet, /ConstraintSeeds|ConstraintHasOne/, [wallet, differentWallet]);
const missingWallet = await update(); missingWallet.instructions[1].keys[0].pubkey = differentWallet.publicKey;
await reject('missing wallet signature', missingWallet, /Signature verification failed|Missing signature/);
const replay = await update();
const updatedSignature = await send(await update());
const after = await fetchUserAccount(connection, auth, wallet.publicKey);
assert.equal(after.nextSequence, 2n);
assert.equal(after.profileReference, hex(reference));
await assert.rejects(() => send(replay), /InvalidSequence/);
assert.deepEqual(await fetchUserAccount(connection, auth, wallet.publicKey), after);
rejected.push('approval replay');
console.log(JSON.stringify({ user: after.address, created, updatedSignature, nextSequence: after.nextSequence.toString(), negativeChecks: rejected }, null, 2));
