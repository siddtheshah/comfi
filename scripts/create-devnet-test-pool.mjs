import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = resolve(root, 'fixtures/devnet/runtime');
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/devnet/public.json'), 'utf8'));
const deployerPath = process.argv.find((argument) => argument.startsWith('--deployer='))?.slice('--deployer='.length);
if (!deployerPath) throw new Error('Pass --deployer=/absolute/path/to/the-funded-devnet-deployer.json');

async function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, 'utf8'))));
}

async function loadOrCreateKeypair(path) {
  try {
    return await loadKeypair(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const keypair = Keypair.generate();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    return keypair;
  }
}

const deployer = await loadKeypair(deployerPath);
const creator = await loadOrCreateKeypair(resolve(runtimeDirectory, 'pool-creator.keypair.json'));
const connection = new Connection(fixture.rpcUrl, 'confirmed');
const programId = new PublicKey(fixture.programId);
const mint = new PublicKey(fixture.testMint);
const treasury = new PublicKey(fixture.treasuryTokenAccount);
const idl = JSON.parse(await readFile(resolve(root, 'target/idl/comfi.json'), 'utf8'));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId);
const globalAccount = await program.account.globalConfig.fetch(global);
if (!globalAccount.administrator.equals(deployer.publicKey)) throw new Error('The supplied deployer is not the GlobalConfig administrator.');
if (globalAccount.pausedNewPools) throw new Error('New pool creation is paused.');

if (await connection.getBalance(creator.publicKey, 'confirmed') < LAMPORTS_PER_SOL / 20) {
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
    fromPubkey: deployer.publicKey,
    toPubkey: creator.publicKey,
    lamports: LAMPORTS_PER_SOL / 10,
  })), [deployer], { commitment: 'confirmed' });
}

const creatorUsdc = await getOrCreateAssociatedTokenAccount(connection, deployer, mint, creator.publicKey);
const initialDeposit = 10_000_000n;
const enrollmentFee = 1_000_000n;
const requiredBalance = initialDeposit + enrollmentFee;
const currentBalance = (await getAccount(connection, creatorUsdc.address)).amount;
if (currentBalance < requiredBalance) {
  await mintTo(connection, deployer, mint, creatorUsdc.address, deployer, requiredBalance - currentBalance);
}

const poolId = new BN(globalAccount.nextPoolId.toString());
const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), poolId.toArrayLike(Buffer, 'le', 8)], programId);
const [vault] = PublicKey.findProgramAddressSync([
  pool.toBuffer(),
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
  mint.toBuffer(),
], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
const [creatorMember] = PublicKey.findProgramAddressSync([Buffer.from('member'), pool.toBuffer(), creator.publicKey.toBuffer()], programId);

const signature = await program.methods.createPool({
  memberCap: 10,
  minimumDeposit: new BN(initialDeposit.toString()),
  memberObligationAmount: new BN(initialDeposit.toString()),
  initialDeposit: new BN(initialDeposit.toString()),
  enrollmentFee: new BN(enrollmentFee.toString()),
  voteThreshold: 5001,
  votingPeriodSeconds: new BN(604800),
  timelockSeconds: new BN(86400),
  cycleDurationSeconds: new BN(2592000),
  actionAllowancePerCycle: new BN(1_000_000),
  maxSponsoredActionCharge: new BN(100_000),
  creatorAliasHash: Array(32).fill(0),
  creatorEncryptionPublicKey: Array(32).fill(0),
  testingEnabled: false,
  spenderLimitDeadlineCycles: new BN(1),
  withdrawalDeadlineCycles: new BN(1),
  configModificationDeadlineCycles: new BN(2),
  spenderLimitExecutionMode: { onDeadline: {} },
  withdrawalExecutionMode: { onDeadline: {} },
  configModificationExecutionMode: { onDeadline: {} },
}).accounts({
  creator: creator.publicKey,
  global,
  creatorUsdc: creatorUsdc.address,
  treasuryUsdc: treasury,
  pool,
  vault,
  usdcMint: mint,
  creatorMember,
}).signers([creator]).rpc();

console.log(JSON.stringify({ poolId: poolId.toString(), pool: pool.toBase58(), vault: vault.toBase58(), creator: creator.publicKey.toBase58(), creatorUsdc: creatorUsdc.address.toBase58(), signature }, null, 2));
