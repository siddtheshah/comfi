import { PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'

export const poolAddress = 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M'
export const creator = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'

// Independent Borsh writer in Rust Pool declaration order, including Option payloads.
export function poolBytes({ head = true, cursor = false, pending = false, closing = false, locked = true, open = false } = {}) {
  const parts: Buffer[] = []
  const byte = (v: number) => parts.push(Buffer.from([v]))
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b) }
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); parts.push(b) }
  const key = (s: string) => parts.push(Buffer.from(new PublicKey(s).toBytes()))
  const optionKey = (present: boolean) => { byte(+present); if (present) key(creator) }
  const optionU64 = (present: boolean, v: bigint) => { byte(+present); if (present) u64(v) }
  parts.push(createHash('sha256').update('account:Pool').digest().subarray(0, 8))
  key(creator); u64(0n); key(creator); key(poolAddress)
  u32(24); u32(4); u64(10_000_000n); u64(25_000_000n); u32(2)
  u64(604800n); u64(86400n); u64(9n); u64(2592000n); u64(1790051252n)
  u64(10n); u64(1000n); u64(7n); u64(5n)
  byte(255); byte(1); byte(+pending); u32(3); u64(30n); u64(30_000_000n)
  for (const n of [1n, 2n, 3n, 4n, 5n, 6n]) u64(n)
  for (const n of [0, 1, 0, 1, 0, 1]) byte(n)
  byte(+closing); u64(30_000_000n); u64(3n); byte(1)
  u64(4_000_000n); u32(1); u64(123n); u64(1n); // u128 benefit, low then high
  u64(9_007_199_254_740_993n); byte(+closing); u64(100_000_000n); u64(30_000_000n); u64(70_000_000n)
  optionKey(head); optionKey(cursor); byte(+locked); u32(2); u32(5001)
  u64(2n); u64(3n); u32(3); u32(6000); u64(4n)
  u64(2_000_000n); u64(3n); byte(1); u64(4n); byte(0); byte(+open)
  u64(2n); u64(1n); u32(1)
  byte(+pending); if (pending) byte(1)
  optionU64(pending, 3n); optionU64(pending, 2n)
  return Buffer.concat(parts)
}
