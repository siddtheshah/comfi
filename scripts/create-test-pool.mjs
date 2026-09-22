import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rpcUrl = process.env.COMFI_LOCALNET_RPC ?? 'http://127.0.0.1:8899';
const programId = new PublicKey('bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY');
const localnetDirectory = resolve(root, '.localnet');
const statePath = resolve(localnetDirectory, 'state.json');
const publicOutputPath = resolve(root, 'localnet.json');
const usdcDecimals = 6;
const oneUsdc = 10n ** BigInt(usdcDecimals);
const operation = process.env.COMFI_POOL_MODE ?? 'bootstrap';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/.test(rpcUrl)) throw new Error(`Refusing to run outside localnet: ${rpcUrl}`);
const connection = new Connection(rpcUrl, 'confirmed');
await connection.getLatestBlockhash();
await mkdir(localnetDirectory, { recursive: true });

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function keypair(name, fallback) {
  const path = resolve(localnetDirectory, `${name}.json`);
  const stored = await readJson(path, null);
  if (stored) return Keypair.fromSecretKey(Uint8Array.from(stored));
  const next = fallback ?? Keypair.generate();
  await writeFile(path, JSON.stringify(Array.from(next.secretKey)), 'utf8');
  return next;
}
async function fund(wallet) {
  if (await connection.getBalance(wallet.publicKey) >= LAMPORTS_PER_SOL) return;
  const signature = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, 'confirmed');
}

const administrator = await keypair('administrator');
// This signer matches the development-only public key exposed by the mock wallet.
// It never leaves .localnet and is never emitted to a browser bundle.
const creator = await keypair('creator', Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7)));
const quoteAuthority = await keypair('quote-authority');
await fund(administrator);

const idl = JSON.parse(await readFile(resolve(root, 'target/idl/comfi.json'), 'utf8'));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(administrator), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId);
let state = await readJson(statePath, {});
let globalAccount = await program.account.globalConfig.fetchNullable(global);
if (!globalAccount && (operation === 'next' || operation === 'fund-wallet')) throw new Error('Localnet has not been initialized. Initialize the deployer before creating a pool.');
// A previous interrupted run may have initialized the global PDA before it
// wrote state.json. In that case, resume with its immutable mint and treasury.
let mint = globalAccount ? globalAccount.usdcMint : (state.mint ? new PublicKey(state.mint) : undefined);
if (!mint || !(await connection.getAccountInfo(mint))) mint = await createMint(connection, administrator, administrator.publicKey, null, usdcDecimals);
const treasury = globalAccount ? { address: globalAccount.treasuryUsdc } : await getOrCreateAssociatedTokenAccount(connection, administrator, mint, administrator.publicKey);

if (!globalAccount) {
  await program.methods.initializeGlobalConfig(quoteAuthority.publicKey).accounts({ administrator: administrator.publicKey, usdcMint: mint, treasuryUsdc: treasury.address, global }).rpc();
  globalAccount = await program.account.globalConfig.fetch(global);
}
if (!globalAccount.usdcMint.equals(mint) || !globalAccount.treasuryUsdc.equals(treasury.address)) throw new Error('Existing GlobalConfig uses a different mint or treasury. Reset localnet and delete .localnet before retrying.');

if (operation === 'initialize') {
  state = { ...state, mint: mint.toBase58() };
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  const output = { operation: 'initialize', rpcUrl, programId: programId.toBase58(), mint: mint.toBase58(), treasury: treasury.address.toBase58(), global: global.toBase58(), demoCreator: creator.publicKey.toBase58(), generatedAt: new Date().toISOString() };
  await writeFile(publicOutputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

await fund(creator);
const creatorUsdc = await getOrCreateAssociatedTokenAccount(connection, creator, mint, creator.publicKey);
if ((await getAccount(connection, creatorUsdc.address)).amount < 1_000n * oneUsdc) await mintTo(connection, administrator, mint, creatorUsdc.address, administrator, 10_000n * oneUsdc);

if (operation === 'fund-wallet') {
  state = { ...state, mint: mint.toBase58() };
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  const output = { operation, rpcUrl, programId: programId.toBase58(), mint: mint.toBase58(), global: global.toBase58(), demoCreator: creator.publicKey.toBase58(), demoCreatorUsdc: creatorUsdc.address.toBase58(), demoCreatorUsdcAmount: (await getAccount(connection, creatorUsdc.address)).amount.toString(), generatedAt: new Date().toISOString() };
  await writeFile(publicOutputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

const poolId = operation === 'next' ? new BN(globalAccount.nextPoolId.toString()) : new BN(0);
const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), poolId.toArrayLike(Buffer, 'le', 8)], programId);
let poolAccount = await program.account.pool.fetchNullable(pool);
if (!poolAccount) {
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const [vault] = PublicKey.findProgramAddressSync([pool.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedTokenProgram);
  const [creatorMember] = PublicKey.findProgramAddressSync([Buffer.from('member'), pool.toBuffer(), creator.publicKey.toBuffer()], programId);
  await program.methods.createPool({
    memberCap: 24, minimumDeposit: new BN(10n * oneUsdc), initialDeposit: new BN(100n * oneUsdc), enrollmentFee: new BN(1n * oneUsdc),
    voteThreshold: 2, votingPeriodSeconds: new BN(604800), timelockSeconds: new BN(86400), cycleDurationSeconds: new BN(2592000),
    actionAllowancePerCycle: new BN(5n * oneUsdc), maxSponsoredActionCharge: new BN(1n * oneUsdc), creatorAliasHash: Array(32).fill(0), creatorEncryptionPublicKey: Array(32).fill(0),
  }).accounts({ creator: creator.publicKey, global, creatorUsdc: creatorUsdc.address, treasuryUsdc: treasury.address, pool, vault, usdcMint: mint, creatorMember }).signers([creator]).rpc();
  poolAccount = await program.account.pool.fetch(pool);
}
state = { mint: mint.toBase58(), pool: pool.toBase58() };
await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
const output = { operation, rpcUrl, programId: programId.toBase58(), mint: mint.toBase58(), treasury: treasury.address.toBase58(), global: global.toBase58(), pool: pool.toBase58(), demoCreator: creator.publicKey.toBase58(), poolMemberCount: poolAccount.memberCount, generatedAt: new Date().toISOString() };
await writeFile(publicOutputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify(output, null, 2));
