// Exercise the ordinary ComFi binary on an isolated localnet, including the
// ExecuteSpenderLimit account validator whose stack usage is checked at build.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { requireLocalnet } from './client.mjs';
import { confirmWalletTransaction } from '../../apps/web/src/transaction-confirmation.ts';

const connection = new Connection(requireLocalnet(process.argv[2]), 'confirmed');
assert(process.env.COMFI_LOCALNET_STATE_DIR, 'An isolated fixture directory is required');
const keypair = async name => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(process.env.COMFI_LOCALNET_STATE_DIR, `${name}.json`), 'utf8'))));
const administrator = await keypair('administrator'), creator = await keypair('creator');
const program = new anchor.Program(JSON.parse(await readFile('target/idl/comfi.json', 'utf8')), new anchor.AnchorProvider(connection, new anchor.Wallet(creator), { commitment: 'confirmed' }));
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const text = value => Buffer.from(value), number = value => new BN(value).toArrayLike(Buffer, 'le', 8);
const global = pda(text('global')), config = await program.account.globalConfig.fetch(global);
const latest = await connection.getLatestBlockhash('confirmed');
await confirmWalletTransaction(connection, await connection.requestAirdrop(creator.publicKey, 2_000_000_000), latest);
const source = await getOrCreateAssociatedTokenAccount(connection, administrator, config.usdcMint, creator.publicKey);
await mintTo(connection, administrator, config.usdcMint, source.address, administrator, 100_000_000n);
const pool = pda(text('pool'), number(config.nextPoolId)), member = pda(text('member'), pool.toBuffer(), creator.publicKey.toBuffer());
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const vault = PublicKey.findProgramAddressSync([pool.toBuffer(), tokenProgram.toBuffer(), config.usdcMint.toBuffer()], associated)[0];
await program.methods.createPool({
  memberCap: 3, minimumDeposit: new BN(1_000_000), memberObligationAmount: new BN(10_000_000), initialDeposit: new BN(20_000_000), enrollmentFee: new BN(1_000_000),
  voteThreshold: 5001, votingPeriodSeconds: new BN(15), timelockSeconds: new BN(0), cycleDurationSeconds: new BN(15),
  actionAllowancePerCycle: new BN(5_000_000), maxSponsoredActionCharge: new BN(1_000_000), creatorAliasHash: Array(32).fill(0), creatorEncryptionPublicKey: Array(32).fill(0), testingEnabled: false,
  spenderLimitDeadlineCycles: new BN(1), withdrawalDeadlineCycles: new BN(1), configModificationDeadlineCycles: new BN(2),
  spenderLimitExecutionMode: { thresholdMet: {} }, withdrawalExecutionMode: { onDeadline: {} }, configModificationExecutionMode: { onDeadline: {} },
}).accounts({ creator: creator.publicKey, global, creatorUsdc: source.address, treasuryUsdc: config.treasuryUsdc, pool, vault, usdcMint: config.usdcMint, creatorMember: member }).rpc();
const proposal = pda(text('proposal'), pool.toBuffer(), number(0));
await program.methods.createProposal({ setSpenderLimit: { member, cap: new BN(5_000_000) } }).accounts({ proposerWallet: creator.publicKey, pool, proposer: member, proposal }).rpc();
const cycleAddress = cycle => pda(text('cycle'), pool.toBuffer(), member.toBuffer(), number(cycle));
const execute = cycle => program.methods.executeSpenderLimit().accounts({ executor: creator.publicKey, pool, proposal, spenderMember: member, spenderCycle: cycleAddress(cycle) }).rpc();
await assert.rejects(() => execute(0), /ProposalNotExecutable/);
assert.equal(await connection.getAccountInfo(cycleAddress(0)), null, 'Rejected execution must not leave an initialized cycle');
async function roll() {
  const state = await program.account.pool.fetch(pool);
  const boundary = Number(state.cycleStartedAt) + Number(state.cycleDurationSeconds);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const time = await connection.getBlockTime(await connection.getSlot('confirmed'));
    if (time !== null && time >= boundary) {
      await program.methods.rollCycle().accounts({ pool, cranker: creator.publicKey }).remainingAccounts([{ pubkey: member, isSigner: false, isWritable: true }]).rpc();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Cycle boundary did not arrive');
}
await roll();
const receipt = pda(text('vote'), proposal.toBuffer(), member.toBuffer());
await program.methods.vote(true).accounts({ voterWallet: creator.publicKey, pool, proposal, voter: member, receipt }).rpc();
await program.methods.finalizeProposal().accounts({ pool, proposal }).rpc();
await assert.rejects(() => execute(1), /ExecutionCycleNotReached/);
await program.methods.deposit(new BN(10_000_000)).accounts({ memberWallet: creator.publicKey, global, pool, member, sourceUsdc: source.address, vault }).rpc();
await roll();
await execute(2);
const cycle = await program.account.spenderCycle.fetch(cycleAddress(2));
assert(cycle.pool.equals(pool)); assert(cycle.member.equals(member));
assert.equal(cycle.cap.toString(), '5000000'); assert.equal(cycle.cycle.toString(), '2'); assert.equal(cycle.spent.toString(), '0');
assert.deepEqual((await program.account.proposal.fetch(proposal)).state, { executed: {} });
await assert.rejects(() => execute(2), /ProposalNotExecutable/);
console.log('ComFi ordinary-build localnet: pool, proposal, vote, two real cycle rolls, spender-limit execution, and 3 rejection/rollback checks passed.');
