import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { creator, poolAddress } from './pool.ts'

export const programId = '3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP'
export const memberAddress = PublicKey.findProgramAddressSync([Buffer.from('member'), new PublicKey(poolAddress).toBuffer(), new PublicKey(creator).toBuffer()], new PublicKey(programId))[0].toBase58()
export const proposalAddress = PublicKey.findProgramAddressSync([Buffer.from('proposal'), new PublicKey(poolAddress).toBuffer(), Buffer.alloc(8)], new PublicKey(programId))[0].toBase58()
export function writer(name: string) {
  const parts: Buffer[] = [createHash('sha256').update(`account:${name}`).digest().subarray(0,8)]
  return { byte(v: number) { parts.push(Buffer.from([v])) }, u32(v: number) { const b=Buffer.alloc(4);b.writeUInt32LE(v);parts.push(b) }, u64(v: bigint) { const b=Buffer.alloc(8);b.writeBigUInt64LE(v);parts.push(b) }, key(v: string) { parts.push(new PublicKey(v).toBuffer()) }, zeros(n:number) { parts.push(Buffer.alloc(n)) }, result() { return Buffer.concat(parts) } }
}
export function proposalBytes(kind = 3, state = 0, mode = 0) {
  const w=writer('Proposal');w.key(poolAddress);w.u64(0n);w.key(memberAddress);w.byte(kind)
  switch(kind) {
    case 0: w.key(memberAddress);w.u64(9_007_199_254_740_993n);break
    case 1: w.key(proposalAddress);break
    case 2: w.u32(7000); for(const v of [60n,25_000_000n,1n,2n,3n])w.u64(v);w.byte(0);w.byte(1);w.byte(0);break
    case 4: w.key(memberAddress);break
    case 5: w.key(poolAddress);w.key(creator);break
  }
  w.u32(2);w.u32(0);for(const v of [9n,10n,11n,2_000_000_000n,1_790_000_000n])w.u64(v)
  w.byte(state);w.byte(255);w.byte(mode);w.u32(5001)
  return w.result()
}
export function memberBytes({ next = false, vouch = false } = {}) {
  const w=writer('Member');w.key(poolAddress);w.key(creator);w.byte(2);w.byte(1);w.u64(25_000_000n)
  w.zeros(32+32);w.u32(1);w.u64(9n);w.u64(0n);w.byte(255)
  w.u64(2_000_000n);w.u64(0n);w.byte(0);w.zeros(16);w.u64(0n);w.u64(27_000_000n);w.u64(9n);w.u64(9n);w.byte(0)
  w.byte(+next);if(next)w.key(proposalAddress);w.byte(0);w.u64(0n);w.byte(+vouch);if(vouch)w.key(memberAddress)
  w.u32(1);w.u32(0);w.u64(2n);w.u64(3n);w.byte(1)
  return w.result()
}
export function withdrawalBytes() {const w=writer('WithdrawalRequest');w.key(poolAddress);w.u64(0n);w.key(memberAddress);w.key(creator);w.u64(5_000_000n);w.zeros(32);w.byte(1);w.byte(0);w.byte(255);return w.result()}
