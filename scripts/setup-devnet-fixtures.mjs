import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { createMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = resolve(root, 'fixtures/devnet/runtime');
const manifestPath = resolve(runtimeDirectory, 'public.json');
const programId = new PublicKey('bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY');
const rpcUrl = 'https://api.devnet.solana.com';
const decimals = 6;

function argumentValue(name) {
  const prefix = `--${name}=`;
  const equalArgument = process.argv.find((argument) => argument.startsWith(prefix));
  if (equalArgument) return equalArgument.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const deployerPath = argumentValue('deployer');
const quoteAuthorityPath = argumentValue('quote-authority') ?? resolve(runtimeDirectory, 'quote-authority.keypair.json');
if (!deployerPath) throw new Error('Pass the funded Devnet deployer with --deployer=/absolute/path/to/keypair.json');

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

async function latestSignature(connection, address) {
  const [signature] = await connection.getSignaturesForAddress(address, { limit: 1 });
  return signature?.signature ?? null;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

const deployer = await loadKeypair(deployerPath);
const quoteAuthority = await loadOrCreateKeypair(quoteAuthorityPath);
const connection = new Connection(rpcUrl, 'confirmed');
const balance = await connection.getBalance(deployer.publicKey, 'confirmed');
if (balance === 0) throw new Error(`Deployer ${deployer.publicKey.toBase58()} has no Devnet SOL.`);

const idl = JSON.parse(await readFile(resolve(root, 'target/idl/comfi.json'), 'utf8'));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from('global')], programId);
const existingGlobal = await program.account.globalConfig.fetchNullable(globalConfig);

let testMint;
let treasuryTokenAccount;
let createMintSignature = null;
let createTreasuryTokenAccountSignature = null;
let initializeGlobalConfig = null;
if (existingGlobal) {
  testMint = existingGlobal.usdcMint;
  treasuryTokenAccount = existingGlobal.treasuryUsdc;
  if (!existingGlobal.admin.equals(deployer.publicKey)) {
    throw new Error(`GlobalConfig is already administered by ${existingGlobal.admin.toBase58()}, not this deployer.`);
  }
  if (!existingGlobal.quoteAuthority.equals(quoteAuthority.publicKey)) {
    throw new Error(`GlobalConfig already uses quote authority ${existingGlobal.quoteAuthority.toBase58()}; refusing to replace it.`);
  }
} else {
  testMint = await createMint(connection, deployer, deployer.publicKey, null, decimals);
  createMintSignature = await latestSignature(connection, testMint);
  const treasury = await getOrCreateAssociatedTokenAccount(connection, deployer, testMint, deployer.publicKey);
  treasuryTokenAccount = treasury.address;
  createTreasuryTokenAccountSignature = await latestSignature(connection, treasuryTokenAccount);
  initializeGlobalConfig = await program.methods
    .initializeGlobalConfig(quoteAuthority.publicKey)
    .accounts({
      administrator: deployer.publicKey,
      usdcMint: testMint,
      treasuryUsdc: treasuryTokenAccount,
      global: globalConfig,
    })
    .rpc();
}

const previousManifest = await readJson(manifestPath, {});

const manifest = {
  cluster: 'devnet',
  rpcUrl,
  programId: programId.toBase58(),
  programData: '6YnjNLg1SE9K4ggWsyT6ejPU1s8XFmozCyrw8232btbm',
  upgradeAuthority: 'Cu5th5dsqqZ3hQ1MAfNPjwktgb4ktQ4z7yuD5Yvwu14f',
  globalConfig: globalConfig.toBase58(),
  testMint: testMint.toBase58(),
  treasuryAuthority: deployer.publicKey.toBase58(),
  treasuryTokenAccount: treasuryTokenAccount.toBase58(),
  quoteAuthority: quoteAuthority.publicKey.toBase58(),
  members: [],
  transactions: {
    createMint: createMintSignature ?? previousManifest.transactions?.createMint ?? null,
    createTreasuryTokenAccount: createTreasuryTokenAccountSignature ?? previousManifest.transactions?.createTreasuryTokenAccount ?? null,
    initializeGlobalConfig: initializeGlobalConfig ?? previousManifest.transactions?.initializeGlobalConfig ?? null,
  },
};

await mkdir(runtimeDirectory, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
