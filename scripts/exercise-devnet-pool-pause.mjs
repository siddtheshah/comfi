import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/devnet/public.json'), 'utf8'));
const poolFixture = fixture.pools?.find((pool) => pool.id === 0);
if (!poolFixture) throw new Error('Pool #0 is not recorded in fixtures/devnet/public.json.');
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(root, 'fixtures/devnet/runtime/pool-creator.keypair.json'), 'utf8'))));
const connection = new Connection(fixture.rpcUrl, 'confirmed');
const idl = JSON.parse(await readFile(resolve(root, 'target/idl/comfi.json'), 'utf8'));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(creator), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const pool = new PublicKey(poolFixture.address);
const [member] = PublicKey.findProgramAddressSync([Buffer.from('member'), pool.toBuffer(), creator.publicKey.toBuffer()], new PublicKey(fixture.programId));
const before = await program.account.member.fetch(member);
if (before.isPaused) throw new Error('Pool creator is already paused; refusing to alter the fixture state.');

const pause = await program.methods.setPaused(true).accounts({ memberWallet: creator.publicKey, member, pool }).rpc();
const paused = await program.account.member.fetch(member);
if (!paused.isPaused) throw new Error('Pause transaction finalized without setting the member pause preference.');

const unpause = await program.methods.setPaused(false).accounts({ memberWallet: creator.publicKey, member, pool }).rpc();
const after = await program.account.member.fetch(member);
if (after.isPaused) throw new Error('Unpause transaction finalized without clearing the member pause preference.');

console.log(JSON.stringify({ member: member.toBase58(), initialPaused: before.isPaused, pause, pausedAfterPause: paused.isPaused, unpause, finalPaused: after.isPaused }, null, 2));
