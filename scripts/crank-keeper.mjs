import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rpcUrl = process.env.COMFI_RPC_URL ?? process.env.COMFI_LOCALNET_RPC ?? 'http://127.0.0.1:8899';
const programId = new PublicKey('bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY');
const localnetDirectory = resolve(root, '.localnet');
const isOnce = process.argv.includes('--once');
const pollIntervalMs = Number(process.env.COMFI_CRANK_INTERVAL_MS ?? 5000);

const connection = new Connection(rpcUrl, 'confirmed');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadKeypair(name, fallback) {
  await mkdir(localnetDirectory, { recursive: true });
  const path = resolve(localnetDirectory, `${name}.json`);
  const stored = await readJson(path, null);
  if (stored) return Keypair.fromSecretKey(Uint8Array.from(stored));
  const next = fallback ?? Keypair.generate();
  await writeFile(path, JSON.stringify(Array.from(next.secretKey)), 'utf8');
  return next;
}

async function ensureFunded(wallet, minLamports = LAMPORTS_PER_SOL) {
  const balance = await connection.getBalance(wallet.publicKey);
  if (balance < minLamports) {
    try {
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch {
      // In non-localnet environments, airdrop may fail; proceed with existing balance
    }
  }
}

function parseExecutionMode(mode) {
  if (!mode) return 'on_deadline';
  if (typeof mode === 'string') return mode.toLowerCase();
  if (mode.thresholdMet) return 'threshold_met';
  if (mode.onDeadline) return 'on_deadline';
  return 'on_deadline';
}

export async function processPoolCycleRoll(program, poolItem, cranker) {
  const poolPubkey = poolItem.publicKey;
  const pool = poolItem.account;

  const currentCycle = new BN(pool.currentCycle.toString());
  const cycleDuration = new BN(pool.cycleDuration.toString());
  const startTime = new BN(pool.startTime.toString());

  // next_start = start_time + (current_cycle + 1) * cycle_duration
  const nextCycle = currentCycle.addn(1);
  const nextStart = startTime.add(nextCycle.mul(cycleDuration));

  // Determine current on-chain or wall-clock timestamp
  const nowSec = Math.floor(Date.now() / 1000);

  if (nowSec < nextStart.toNumber()) {
    return { rolled: false, reason: 'cycle_not_elapsed', nextStart: nextStart.toNumber() };
  }

  console.log(`[Keeper] Pool ${poolPubkey.toBase58()} cycle ${currentCycle.toString()} has elapsed (nextStart: ${nextStart.toString()}, now: ${nowSec}). Rolling cycle...`);

  // Fetch all members of the pool
  const poolMembers = await program.account.member.all([
    { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
  ]);

  // Fetch all proposals of the pool
  const poolProposals = await program.account.proposal.all([
    { memcmp: { offset: 8, bytes: poolPubkey.toBase58() } },
  ]);

  const remainingAccounts = [];

  // 1. Members: traverse singly-linked list pointer chain starting at rolloverCursor or headMember
  const memberMap = new Map();
  for (const item of poolMembers) {
    memberMap.set(item.publicKey.toBase58(), item);
  }

  let currentMemberKey = pool.rolloverCursor ?? pool.headMember;
  while (currentMemberKey) {
    const keyStr = currentMemberKey.toBase58 ? currentMemberKey.toBase58() : new PublicKey(currentMemberKey).toBase58();
    remainingAccounts.push({ pubkey: new PublicKey(keyStr), isWritable: true, isSigner: false });
    const memberItem = memberMap.get(keyStr);
    currentMemberKey = memberItem?.account?.nextMember ?? null;
  }

  // 2. Proposals: ready for resolution
  for (const item of poolProposals) {
    const p = item.account;
    const stateIsActive = p.state.open || p.state.queued;
    const isVotingActive = currentCycle.gte(p.votingCycle);
    const isDeadline = currentCycle.gte(p.deadlineCycle);
    const isThresholdMetMode = parseExecutionMode(p.executionMode) === 'threshold_met';
    const propThreshold = p.voteThreshold ?? pool.voteThreshold;
    const passed = p.yesVotes >= propThreshold && p.yesVotes > p.noVotes;
    const shouldResolve = isThresholdMetMode ? (passed || isDeadline) : isDeadline;

    if (stateIsActive && isVotingActive && shouldResolve) {
      remainingAccounts.push({ pubkey: item.publicKey, isWritable: true, isSigner: false });
      if (p.action.setSpenderLimit) {
        const targetMember = p.action.setSpenderLimit.member;
        remainingAccounts.push({ pubkey: targetMember, isWritable: true, isSigner: false });
        const [spenderCyclePda] = PublicKey.findProgramAddressSync(
          [Buffer.from('cycle'), poolPubkey.toBuffer(), targetMember.toBuffer(), nextCycle.toArrayLike(Buffer, 'le', 8)],
          programId
        );
        remainingAccounts.push({ pubkey: spenderCyclePda, isWritable: true, isSigner: false });
      }
    }
  }

  const initialBalance = await connection.getBalance(cranker.publicKey);

  const tx = await program.methods
    .rollCycle()
    .accounts({
      pool: poolPubkey,
      cranker: cranker.publicKey,
    })
    .remainingAccounts(remainingAccounts)
    .signers([cranker])
    .rpc();

  const finalBalance = await connection.getBalance(cranker.publicKey);
  const netLamports = finalBalance - initialBalance;

  console.log(`[Keeper] Successfully rolled cycle for pool ${poolPubkey.toBase58()}! Tx: ${tx}`);
  console.log(`[Keeper] Cranker fee reimbursement: net lamport delta = ${netLamports} lamports (reimbursed by pool)`);

  return { rolled: true, tx, netLamports, pool: poolPubkey.toBase58() };
}

export async function runKeeperCycle(program, cranker) {
  const pools = await program.account.pool.all();
  let rolledCount = 0;

  for (const poolItem of pools) {
    try {
      const result = await processPoolCycleRoll(program, poolItem, cranker);
      if (result.rolled) rolledCount++;
    } catch (err) {
      console.error(`[Keeper] Error processing pool ${poolItem.publicKey.toBase58()}:`, err);
    }
  }

  return { totalPools: pools.length, rolledCount };
}

async function main() {
  console.log(`[Keeper] Starting Comfi Crank Keeper service on ${rpcUrl}...`);

  const cranker = await loadKeypair('cranker');
  await ensureFunded(cranker);

  const idlPath = resolve(root, 'target/idl/comfi.json');
  const idl = await readJson(idlPath, null);
  if (!idl) {
    throw new Error(`IDL not found at ${idlPath}. Please run anchor build first.`);
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(cranker), { commitment: 'confirmed' });
  const program = new anchor.Program(idl, provider);

  console.log(`[Keeper] Cranker wallet: ${cranker.publicKey.toBase58()}`);

  if (isOnce) {
    const summary = await runKeeperCycle(program, cranker);
    console.log(`[Keeper] Single pass completed: checked ${summary.totalPools} pools, rolled ${summary.rolledCount}.`);
    return;
  }

  console.log(`[Keeper] Polling pools every ${pollIntervalMs}ms... (Press Ctrl+C to stop)`);
  let running = true;
  process.on('SIGINT', () => {
    console.log('\n[Keeper] Shutting down keeper...');
    running = false;
    process.exit(0);
  });

  while (running) {
    try {
      await runKeeperCycle(program, cranker);
    } catch (error) {
      console.error('[Keeper] Error during cycle pass:', error);
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
}

// Only invoke main when run directly as CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[Keeper] Fatal error:', err);
    process.exit(1);
  });
}
