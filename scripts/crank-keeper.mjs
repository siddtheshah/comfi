import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rpcUrl = process.env.COMFI_RPC_URL ?? process.env.COMFI_LOCALNET_RPC ?? 'http://127.0.0.1:8899';
const programId = new PublicKey('3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP');
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

import {
  getPoolTiming,
  calculateRequiredVotes,
  isProposalPassed,
  shouldResolveProposal,
  traverseMemberChain,
  buildRolloverRemainingAccounts,
  DEFAULT_CHUNK_SIZE,
  parseExecutionMode,
} from '../apps/testing/src/backend/localnet.ts';

export {
  getPoolTiming,
  calculateRequiredVotes,
  isProposalPassed,
  shouldResolveProposal,
  traverseMemberChain,
  buildRolloverRemainingAccounts,
  DEFAULT_CHUNK_SIZE,
  parseExecutionMode,
};

export async function processPoolCycleRoll(program, poolItem, cranker, options = {}) {
  if (!poolItem || !poolItem.account) {
    throw new Error('poolItem with account is required for processPoolCycleRoll');
  }

  const poolPubkey = poolItem.publicKey;
  const pool = poolItem.account;

  const timing = getPoolTiming(pool);
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  if (!timing.isResuming && nowSec < timing.nextStart.toNumber()) {
    return { rolled: false, reason: 'cycle_not_elapsed', nextStart: timing.nextStart.toNumber() };
  }

  const poolKeyStr = poolPubkey?.toBase58 ? poolPubkey.toBase58() : String(poolPubkey);
  console.log(`[Keeper] Pool ${poolKeyStr} cycle ${timing.currentCycle.toString()} has elapsed (nextStart: ${timing.nextStart.toString()}, now: ${nowSec}, isResuming: ${timing.isResuming}). Rolling cycle...`);

  if (!program) {
    if (options.dryRun) {
      return { rolled: false, reason: 'dry_run', timing };
    }
    throw new Error('Program is required to execute cycle roll');
  }

  if (!cranker) {
    throw new Error('Cranker signer is required to execute cycle roll');
  }

  const poolMembers = options.members ?? await program.account.member.all([
    { memcmp: { offset: 8, bytes: poolKeyStr } },
  ]);

  const poolProposals = options.proposals ?? await program.account.proposal.all([
    { memcmp: { offset: 8, bytes: poolKeyStr } },
  ]);

  const effectiveChunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const shouldRollAll = options.allChunks ?? false;
  const txs = [];

  let currentPool = pool;
  let done = false;
  let netLamports = 0;

  const conn = options.connection ?? connection;

  while (!done) {
    const rolloverPlan = buildRolloverRemainingAccounts(
      poolPubkey,
      currentPool,
      poolMembers,
      poolProposals,
      { chunkSize: effectiveChunkSize, programId }
    );

    let initialBalance = 0;
    if (conn && cranker?.publicKey && !options.skipBalanceCheck) {
      initialBalance = await conn.getBalance(cranker.publicKey);
    }

    const tx = await program.methods
      .rollCycle()
      .accounts({
        pool: poolPubkey,
        cranker: cranker.publicKey,
      })
      .remainingAccounts(rolloverPlan.remainingAccounts)
      .signers([cranker])
      .rpc();

    if (conn && cranker?.publicKey && !options.skipBalanceCheck) {
      const finalBalance = await conn.getBalance(cranker.publicKey);
      netLamports += (finalBalance - initialBalance);
    }
    txs.push(tx);

    if (!shouldRollAll || rolloverPlan.isComplete) {
      done = true;
    } else {
      const fetched = await program.account.pool.fetch(poolPubkey);
      currentPool = fetched;
      if (!currentPool.rolloverCursor) {
        done = true;
      }
    }
  }

  const lastTx = txs[txs.length - 1];
  console.log(`[Keeper] Successfully rolled cycle for pool ${poolKeyStr}! Tx: ${lastTx}`);
  console.log(`[Keeper] Cranker fee reimbursement: net lamport delta = ${netLamports} lamports (reimbursed by pool)`);

  return {
    rolled: true,
    tx: lastTx,
    txs,
    netLamports,
    pool: poolKeyStr,
    chunksRolled: txs.length,
  };
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
