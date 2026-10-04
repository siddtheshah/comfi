import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePoolAccountData, poolFromAccount, onChainPoolToPoolItem, quorumHealth, formatUsdc, fetchOnChainPools, fetchVaultBalance, fetchVaultBalanceAtomic, toBase58 } from '../src/solana.ts'
import { poolBytes, poolAddress, creator } from './fixtures/pool.ts'

for (const head of [false, true]) for (const cursor of [false, true]) for (const pending of [false, true]) {
  test(`current Pool decoding with head=${head}, cursor=${cursor}, pending=${pending}`, () => {
    const data = poolBytes({ head, cursor, pending })
    // Slice into a larger allocation to verify byteOffset handling.
    const wrapped = Buffer.concat([Buffer.alloc(3), data, Buffer.alloc(5)]).subarray(3, 3 + data.length)
    const pool = decodePoolAccountData(poolAddress, wrapped)
    assert.equal(pool.memberObligationAmountAtomic, 25_000_000n)
    assert.equal(pool.voteThreshold, 2)
    assert.equal(pool.currentCycle, 9n)
    assert.equal(pool.nextProposalId, 5n)
    const m = pool.metrics!
    assert.equal(m.headMember, head ? creator : null)
    assert.equal(m.rolloverCursor, cursor ? creator : null)
    assert.equal(m.totalConferredCapital, 9_007_199_254_740_993n)
    assert.equal(m.cumulativeBenefitPerMember, (1n << 64n) + 123n)
    assert.equal(m.totalNonConferredCapital, 30_000_000n)
    assert.equal(m.totalEscrowedSurplus, 2_000_000n)
    assert.equal(m.lockedConsecutiveCycles, 2n)
    assert.equal(m.autoCloseCyclesThreshold, 3n)
    assert.equal(m.admissionMode, 'InviteVouched')
    assert.equal(m.votingMaturationCycles, 2n)
    assert.equal(m.pendingAdmissionMode, pending ? 'Open' : null)
    assert.equal(m.pendingVotingMaturationCycles, pending ? 3n : null)
    assert.equal(m.pendingProposalExecutionDelayCycles, pending ? 2n : null)
  })
}

test('legacy layouts keep governance/accounting unavailable; malformed layouts reject', () => {
  for (const length of [206, 235, 283, 289]) {
    assert.equal(decodePoolAccountData(poolAddress, poolBytes().subarray(0, length)).metrics, null)
  }
  assert.throws(() => decodePoolAccountData(poolAddress, new Uint8Array(205)), /Invalid pool account data length/)
  assert.throws(() => decodePoolAccountData(poolAddress, poolBytes().subarray(0, 230)), /Unsupported or truncated/)
  assert.throws(() => decodePoolAccountData(poolAddress, poolBytes().subarray(0, 300)), /Truncated pool metrics/)
  const bad = poolBytes(); bad[0] = 0
  assert.throws(() => decodePoolAccountData(poolAddress, bad), /Invalid Pool account discriminator/)
  const enumBad = poolBytes(); enumBad[283] = 2
  assert.throws(() => decodePoolAccountData(poolAddress, enumBad), /Invalid pool execution mode/)
  const optionBad = poolBytes(); optionBad[368] = 2
  assert.throws(() => decodePoolAccountData(poolAddress, optionBad), /Invalid pool boolean or option tag/)
  assert.throws(() => decodePoolAccountData('invalid', poolBytes()), /Non-base58 character/)
  const hugeId = poolBytes(); hugeId.writeBigUInt64LE(1n << 63n, 40)
  assert.throws(() => decodePoolAccountData(poolAddress, hugeId), /Pool ID exceeds safe integer range/)
  const badCounts = poolBytes(); badCounts.writeUInt32LE(99, 315)
  assert.throws(() => decodePoolAccountData(poolAddress, badCounts), /Invalid quorum/)
  const legacy = Buffer.concat([poolBytes().subarray(0, 128), poolBytes().subarray(136, 214)])
  const old = decodePoolAccountData(poolAddress, legacy)
  assert.equal(old.voteThreshold, 2)
  assert.equal(old.memberObligationAmountAtomic, 10_000_000n)
  assert.equal(old.currentCycle, 9n)
  assert.equal(old.metrics, null)
  const padded = Buffer.alloc(542); poolBytes({ head: false, cursor: false }).copy(padded)
  assert.equal(decodePoolAccountData(poolAddress, padded).metrics!.admissionMode, 'InviteVouched')
  assert.throws(() => toBase58(new Uint8Array()), /expected non-empty/)
})

test('quorum matches contract floor in basis points and auto-close boundaries', () => {
  const m = decodePoolAccountData(poolAddress, poolBytes()).metrics!
  assert.deepEqual(quorumHealth(m, 4), { participationBps: 2500, satisfied: false, cyclesUntilAutoClose: 1n })
  assert.equal(quorumHealth({ ...m, fundedMemberCount: 2, minQuorumMembers: 2, minQuorumBps: 5001 }, 4).satisfied, false)
  assert.equal(quorumHealth({ ...m, fundedMemberCount: 2, minQuorumMembers: 2, minQuorumBps: 5000 }, 4).satisfied, true)
  assert.equal(quorumHealth({ ...m, lockedConsecutiveCycles: 4n }, 4).cyclesUntilAutoClose, 0n)
  assert.equal(quorumHealth({ ...m, autoCloseCyclesThreshold: 0n }, 4).cyclesUntilAutoClose, null)
  assert.equal(quorumHealth({ ...m, fundedMemberCount: 0, votingMemberCount: 0 }, 0).participationBps, 0)
  assert.throws(() => quorumHealth(m, -1), /Invalid quorum/)
  assert.throws(() => quorumHealth({ ...m, fundedMemberCount: 5 }, 4), /Invalid quorum/)
  assert.throws(() => quorumHealth({ ...m, minQuorumBps: 10001 }, 4), /Invalid quorum/)
  for (const field of ['fundedMemberCount', 'votingMemberCount', 'minQuorumMembers', 'minQuorumBps']) {
    for (const value of [-1, NaN, 0.5]) assert.throws(() => quorumHealth({ ...m, [field]: value }, 4), /Invalid quorum/)
  }
  for (const field of ['lockedConsecutiveCycles', 'autoCloseCyclesThreshold']) {
    for (const value of [-1n, 1]) assert.throws(() => quorumHealth({ ...m, [field]: value }, 4), /Invalid quorum/)
  }
})

test('atomic USDC formatting preserves u64 precision and rounds cents', () => {
  assert.equal(formatUsdc(9_007_199_254_740_993n), '$9,007,199,254.74')
  assert.equal(formatUsdc(18_446_744_073_709_551_615n), '$18,446,744,073,709.55')
  assert.equal(formatUsdc(995_000n), '$1.00')
  assert.equal(formatUsdc(0n), '$0.00')
  assert.throws(() => formatUsdc(-1n), /Invalid USDC/)
})

test('local API and direct RPC use the same account decoder', async t => {
  const data = poolBytes({ closing: true, open: true })
  const local = poolFromAccount(poolAddress, data.toString('base64'), '100000000')
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init!.body as string)
    return Response.json(request.method === 'getProgramAccounts' ? { result: [{ pubkey: poolAddress, account: { data: [data.toString('base64'), 'base64'] } }] } : { result: { value: { amount: '100000000' } } })
  })
  const [rpc] = await fetchOnChainPools('http://localhost:8899', creator)
  assert.deepEqual(rpc, local)
  const item = onChainPoolToPoolItem(rpc, creator)
  assert.equal(item.role, 'Creator')
  assert.equal(item.status, 'Closing · Cycle 9')
  assert.equal(item.proposals, 5)
  assert.throws(() => onChainPoolToPoolItem({ ...rpc, minimumDepositAtomic: -1n }), /Invalid USDC atomic amount/)
  assert.equal(onChainPoolToPoolItem(rpc, creator.toLowerCase()).role, 'Membership not loaded')
  assert.equal(await fetchVaultBalance('http://localhost:8899', creator), '$100.00')
  assert.throws(() => poolFromAccount(poolAddress, '', '0'), /Missing pool account data/)
  assert.throws(() => poolFromAccount(poolAddress, data.toString('base64'), '-1'), /Invalid vault atomic amount/)
})

test('RPC failures and malformed responses reject instead of reporting zero balances', async t => {
  await assert.rejects(fetchOnChainPools('', creator), /Missing required argument: rpcUrl/)
  await assert.rejects(fetchOnChainPools('rpc', ''), /Missing required argument: programId/)
  await assert.rejects(fetchVaultBalanceAtomic('', creator), /Missing rpcUrl/)
  await assert.rejects(fetchVaultBalanceAtomic('rpc', ''), /Missing vaultPubkey/)
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  await assert.rejects(fetchVaultBalanceAtomic('rpc', creator), /HTTP error 503/)
  await assert.rejects(fetchOnChainPools('rpc', creator), /status 503/)
  mock.mock.mockImplementation(async () => Response.json({ error: { message: 'unavailable' } }))
  await assert.rejects(fetchVaultBalanceAtomic('rpc', creator), /unavailable/)
  await assert.rejects(fetchOnChainPools('rpc', creator), /unavailable/)
  mock.mock.mockImplementation(async () => Response.json({ result: {} }))
  await assert.rejects(fetchVaultBalanceAtomic('rpc', creator), /Invalid or missing vault/)
  await assert.rejects(fetchOnChainPools('rpc', creator), /Invalid or missing program accounts/)
})
