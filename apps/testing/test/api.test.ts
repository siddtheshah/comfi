import assert from 'node:assert/strict'
import test from 'node:test'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  executeAction,
  formatUsdc,
  parseExecutionMode,
  toExecutionModeArg,
  getPoolTiming,
  calculateRequiredVotes,
  isProposalPassed,
  shouldResolveProposal,
  traverseMemberChain,
  buildRolloverRemainingAccounts,
  DEFAULT_CHUNK_SIZE,
} from '../src/backend/localnet.ts'

test('formatUsdc correctly formats atomic USDC amounts', () => {
  assert.equal(formatUsdc('1000000'), '$1.00')
  assert.equal(formatUsdc(10000000), '$10.00')
  assert.equal(formatUsdc(0), '$0.00')
  assert.equal(formatUsdc('25500000'), '$25.50')
  assert.equal(formatUsdc(123456789n), '$123.46')
})

test('formatUsdc rejects invalid atomic inputs rather than evading failures', () => {
  assert.throws(() => {
    formatUsdc('not-a-number')
  })
})

test('executeAction escalates on unknown actions without evading failures', async () => {
  await assert.rejects(
    async () => {
      await executeAction('unknown_action', {})
    },
    { message: /Unknown action: unknown_action/ }
  )
})

test('executeAction escalates on missing required poolAddress parameter for pool operations', async () => {
  await assert.rejects(
    async () => {
      await executeAction('join_pool', { walletName: 'member2' })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('deposit', { walletName: 'creator', amount: 10 })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('set_alias', { walletName: 'creator' })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('set_paused', { walletName: 'creator', paused: true })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('set_paused', { poolAddress: '11111111111111111111111111111111', walletName: 'creator' })
    },
    { message: /Missing or invalid paused parameter/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('roll_cycle', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_roll_cycle', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_advance_cycles', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_advance_cycles', { poolAddress: '11111111111111111111111111111111', count: -1 })
    },
    { message: /Invalid count/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_set_cycle', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_set_cycle', { poolAddress: '11111111111111111111111111111111', cycle: -1 })
    },
    { message: /Invalid cycle/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_finalize_proposal', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_finalize_proposal', { poolAddress: '11111111111111111111111111111111' })
    },
    { message: /Missing proposalAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('test_reset_member_allowance', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_configuration_modification', {})
    },
    { message: /Missing proposalAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_close_pool', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_close_pool', { poolAddress: '11111111111111111111111111111111' })
    },
    { message: /Missing proposalAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_evict_member', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_evict_member', { poolAddress: '11111111111111111111111111111111' })
    },
    { message: /Missing proposalAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_admit_member', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('execute_admit_member', { poolAddress: '11111111111111111111111111111111' })
    },
    { message: /Missing proposalAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('claim_closure_refund', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('claim_eviction_refund', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('leave_pool', {})
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('create_proposal', { poolAddress: '11111111111111111111111111111111', actionKind: 'EvictMember' })
    },
    { message: /Missing targetMember or targetWalletName/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('create_proposal', { poolAddress: '11111111111111111111111111111111', actionKind: 'EvictMember', targetWalletName: 'invalid_wallet' })
    },
    { message: /Invalid targetWalletName/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('create_proposal', { poolAddress: '11111111111111111111111111111111', actionKind: 'AdmitMember' })
    },
    { message: /Missing candidateWallet/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('create_proposal', { poolAddress: '11111111111111111111111111111111', actionKind: 'UnknownAction' })
    },
    { message: /Unsupported proposal action kind/ }
  )
})

test('executeAction escalates on invalid wallet names', async () => {
  await assert.rejects(
    async () => {
      await executeAction('fund_wallet', { walletName: 'non_existent_wallet' })
    },
    { message: /Invalid wallet name/ }
  )
})

test('sponsor quote action issues and verifies canonical HMAC quote', async () => {
  const result = await executeAction('sponsor_quote', {
    poolAddress: '11111111111111111111111111111111',
    memberAddress: 'SysvarRent111111111111111111111111111111111',
    action: 'set_alias',
    chargeAtomic: '900',
  })
  assert.equal(result.verified, true)
  assert.equal(result.action, 'set_alias')
  assert.ok(result.signature)
})

test('parseExecutionMode correctly converts Rust enum representations to ExecutionMode string', () => {
  assert.equal(parseExecutionMode({ onDeadline: {} }), 'on_deadline')
  assert.equal(parseExecutionMode({ thresholdMet: {} }), 'threshold_met')
  assert.equal(parseExecutionMode('threshold_met'), 'threshold_met')
  assert.equal(parseExecutionMode('ThresholdMet'), 'threshold_met')
  assert.equal(parseExecutionMode('on_deadline'), 'on_deadline')
  assert.equal(parseExecutionMode('OnDeadline'), 'on_deadline')
  assert.equal(parseExecutionMode(null), 'on_deadline')
  assert.equal(parseExecutionMode(undefined), 'on_deadline')
})

test('toExecutionModeArg converts string modes to Anchor instruction object representation', () => {
  assert.deepEqual(toExecutionModeArg('threshold_met'), { thresholdMet: {} })
  assert.deepEqual(toExecutionModeArg('ThresholdMet'), { thresholdMet: {} })
  assert.deepEqual(toExecutionModeArg('on_deadline'), { onDeadline: {} })
  assert.deepEqual(toExecutionModeArg(undefined), { onDeadline: {} })
})

import { processPoolCycleRoll } from '../../../scripts/crank-keeper.mjs'

test('processPoolCycleRoll skips pool if cycle has not elapsed yet', async () => {
  const futureStart = Math.floor(Date.now() / 1000) + 10000
  const mockPoolItem = {
    publicKey: { toBase58: () => 'MockPool111111111111111111111111111111111' },
    account: {
      currentCycle: 0,
      cycleDuration: 3600,
      startTime: futureStart,
      voteThreshold: 5001,
    }
  }

  const result = await processPoolCycleRoll(null, mockPoolItem, null)
  assert.equal(result.rolled, false)
  assert.equal(result.reason, 'cycle_not_elapsed')
})

test('getPoolTiming correctly decodes real on-chain account shape with cycleDurationSeconds and cycleStartedAt', () => {
  const pool = {
    currentCycle: new BN(2),
    cycleDurationSeconds: new BN(86400),
    cycleStartedAt: new BN(1700000000),
    headMember: new PublicKey('11111111111111111111111111111111'),
    rolloverCursor: null,
  }
  const timing = getPoolTiming(pool)
  assert.equal(timing.currentCycle.toNumber(), 2)
  assert.equal(timing.cycleDurationSeconds.toNumber(), 86400)
  assert.equal(timing.cycleStartedAt.toNumber(), 1700000000)
  assert.equal(timing.nextStart.toNumber(), 1700086400) // 1700000000 + 86400
  assert.equal(timing.isResuming, false)

  // Also supports snake_case
  const snakePool = {
    current_cycle: 3,
    cycle_duration_seconds: 3600,
    cycle_started_at: 1000,
  }
  const snakeTiming = getPoolTiming(snakePool)
  assert.equal(snakeTiming.currentCycle.toNumber(), 3)
  assert.equal(snakeTiming.nextStart.toNumber(), 4600)
})

test('getPoolTiming supports backward-compatible legacy account shape', () => {
  const legacyPool = {
    currentCycle: 1,
    cycleDuration: 3600,
    startTime: 5000,
  }
  const timing = getPoolTiming(legacyPool)
  assert.equal(timing.currentCycle.toNumber(), 1)
  assert.equal(timing.cycleDurationSeconds.toNumber(), 3600)
  assert.equal(timing.cycleStartedAt.toNumber(), 5000)
  assert.equal(timing.nextStart.toNumber(), 8600)
  assert.equal(timing.isResuming, false)
})

test('processPoolCycleRoll skips unelapsed cycle for real decoded account shape', async () => {
  const futureStart = Math.floor(Date.now() / 1000) + 50000
  const mockPoolPk = Keypair.generate().publicKey
  const mockPoolItem = {
    publicKey: mockPoolPk,
    account: {
      currentCycle: new BN(1),
      cycleDurationSeconds: new BN(3600),
      cycleStartedAt: new BN(futureStart),
      headMember: null,
      rolloverCursor: null,
      voteThreshold: 5001,
    }
  }

  const result = await processPoolCycleRoll(null, mockPoolItem, null)
  assert.equal(result.rolled, false)
  assert.equal(result.reason, 'cycle_not_elapsed')
  assert.equal(result.nextStart, futureStart + 3600)
})

test('processPoolCycleRoll continues immediately when rolloverCursor is present even if cycle has not elapsed', async () => {
  const futureStart = Math.floor(Date.now() / 1000) + 50000
  const cursorPk = Keypair.generate().publicKey
  const headPk = Keypair.generate().publicKey
  const poolPk = Keypair.generate().publicKey
  const mockPoolItem = {
    publicKey: poolPk,
    account: {
      currentCycle: new BN(1),
      cycleDurationSeconds: new BN(3600),
      cycleStartedAt: new BN(futureStart),
      headMember: headPk,
      rolloverCursor: cursorPk,
      voteThreshold: 5001,
    }
  }

  let rollCycleCalled = false
  let passedRemainingAccounts: any[] = []
  const mockProgram = {
    account: {
      member: { all: async () => [{ publicKey: cursorPk, account: { nextMember: null } }] },
      proposal: { all: async () => [] },
    },
    methods: {
      rollCycle: () => ({
        accounts: () => ({
          remainingAccounts: (accs: any[]) => {
            passedRemainingAccounts = accs
            return {
              signers: () => ({
                rpc: async () => 'tx_mock_signature_chunk',
              }),
            }
          },
        }),
      }),
    },
  }

  const mockCranker = { publicKey: Keypair.generate().publicKey }
  const result = await processPoolCycleRoll(mockProgram, mockPoolItem, mockCranker, { skipBalanceCheck: true })
  assert.equal(result.rolled, true)
  assert.equal(result.tx, 'tx_mock_signature_chunk')
  assert.equal(passedRemainingAccounts.length, 1)
  assert.equal(passedRemainingAccounts[0].pubkey.toBase58(), cursorPk.toBase58())
})

test('traverseMemberChain preserves pointer-chain order and ignores unlinked departed accounts from shuffled RPC results', () => {
  const pk1 = Keypair.generate().publicKey
  const pk2 = Keypair.generate().publicKey
  const pk3 = Keypair.generate().publicKey
  const pkExited = Keypair.generate().publicKey
  const pkRogue = Keypair.generate().publicKey

  const m1 = { publicKey: pk1, account: { nextMember: pk2, status: 'Active' } }
  const m2 = { publicKey: pk2, account: { nextMember: pk3, status: 'Active' } }
  const m3 = { publicKey: pk3, account: { nextMember: null, status: 'Active' } }
  const mExited = { publicKey: pkExited, account: { nextMember: null, status: 'Exited' } }
  const mRogue = { publicKey: pkRogue, account: { nextMember: pk2, status: 'Active' } }

  // RPC returns all accounts shuffled with departed and rogue accounts
  const rpcMembers = [m3, mExited, m1, mRogue, m2]

  const chain = traverseMemberChain(pk1, rpcMembers)
  assert.equal(chain.length, 3)
  assert.equal(chain[0].publicKey.toBase58(), pk1.toBase58())
  assert.equal(chain[1].publicKey.toBase58(), pk2.toBase58())
  assert.equal(chain[2].publicKey.toBase58(), pk3.toBase58())
})

test('buildRolloverRemainingAccounts implements bounded chunking and handles SEC-10 predecessor on resumption', () => {
  const poolPk = Keypair.generate().publicKey
  const pk1 = Keypair.generate().publicKey
  const pk2 = Keypair.generate().publicKey
  const pk3 = Keypair.generate().publicKey
  const pk4 = Keypair.generate().publicKey
  const pk5 = Keypair.generate().publicKey

  const m1 = { publicKey: pk1, account: { nextMember: pk2 } }
  const m2 = { publicKey: pk2, account: { nextMember: pk3 } }
  const m3 = { publicKey: pk3, account: { nextMember: pk4 } }
  const m4 = { publicKey: pk4, account: { nextMember: pk5 } }
  const m5 = { publicKey: pk5, account: { nextMember: null } }
  const allMembers = [m1, m2, m3, m4, m5]

  // Chunk 1: Start at head pk1, chunk size 2
  const poolChunk1 = {
    currentCycle: new BN(1),
    cycleDurationSeconds: new BN(3600),
    cycleStartedAt: new BN(1000),
    headMember: pk1,
    rolloverCursor: null,
    rolloverPrevMember: null,
  }

  const plan1 = buildRolloverRemainingAccounts(poolPk, poolChunk1, allMembers, [], { chunkSize: 2 })
  assert.equal(plan1.isComplete, false)
  assert.equal(plan1.remainingMembersCount, 3)
  assert.equal(plan1.remainingAccounts.length, 2)
  assert.equal(plan1.remainingAccounts[0].pubkey.toBase58(), pk1.toBase58())
  assert.equal(plan1.remainingAccounts[1].pubkey.toBase58(), pk2.toBase58())
  assert.equal(plan1.hasPredecessor, false)

  // Chunk 2: Resuming at cursor pk3, with predecessor pk2 (SEC-10)
  const poolChunk2 = {
    currentCycle: new BN(1),
    cycleDurationSeconds: new BN(3600),
    cycleStartedAt: new BN(1000),
    headMember: pk1,
    rolloverCursor: pk3,
    rolloverPrevMember: pk2,
  }

  const plan2 = buildRolloverRemainingAccounts(poolPk, poolChunk2, allMembers, [], { chunkSize: 2 })
  assert.equal(plan2.isComplete, false)
  assert.equal(plan2.remainingMembersCount, 1)
  assert.equal(plan2.hasPredecessor, true)
  assert.equal(plan2.remainingAccounts.length, 3) // [pk2 (prev), pk3, pk4]
  assert.equal(plan2.remainingAccounts[0].pubkey.toBase58(), pk2.toBase58())
  assert.equal(plan2.remainingAccounts[1].pubkey.toBase58(), pk3.toBase58())
  assert.equal(plan2.remainingAccounts[2].pubkey.toBase58(), pk4.toBase58())

  // Chunk 3: Resuming at cursor pk5 with predecessor pk4 (completes rollover)
  const poolChunk3 = {
    currentCycle: new BN(1),
    cycleDurationSeconds: new BN(3600),
    cycleStartedAt: new BN(1000),
    headMember: pk1,
    rolloverCursor: pk5,
    rolloverPrevMember: pk4,
  }

  const plan3 = buildRolloverRemainingAccounts(poolPk, poolChunk3, allMembers, [], { chunkSize: 2 })
  assert.equal(plan3.isComplete, true)
  assert.equal(plan3.remainingMembersCount, 0)
  assert.equal(plan3.hasPredecessor, true)
  assert.equal(plan3.remainingAccounts.length, 2) // [pk4 (prev), pk5]
  assert.equal(plan3.remainingAccounts[0].pubkey.toBase58(), pk4.toBase58())
  assert.equal(plan3.remainingAccounts[1].pubkey.toBase58(), pk5.toBase58())
})

test('calculateRequiredVotes scales with electorate, cycles, and elevated threshold floors', () => {
  const pool = {
    votingMemberCount: 5,
    fundedMemberCount: 5,
    memberCount: 5,
    voteThreshold: 5000,
  }

  // SetSpenderLimit requires supermajority (elevates threshold to >= 6667 bps)
  // 5 voters * 2 cycles = 10 scaled. ceil(10 * 6667 / 10000) = 7
  const spenderProp = {
    action: { setSpenderLimit: { member: new PublicKey('11111111111111111111111111111111'), limit: 100 } },
    voteThreshold: 5000,
    votingCycle: 1,
    deadlineCycle: 2,
  }
  assert.equal(calculateRequiredVotes(pool, spenderProp), 7)

  // ApproveWithdrawal requires majority (elevates threshold to >= 5001 bps)
  // 3 voters * 1 cycle = 3 scaled. ceil(3 * 5001 / 10000) = 2
  const pool3 = {
    votingMemberCount: 3,
    fundedMemberCount: 3,
    memberCount: 3,
    voteThreshold: 5000,
  }
  const withdrawalProp = {
    action: { approveWithdrawal: { amount: 100 } },
    voteThreshold: 5000,
    votingCycle: 1,
    deadlineCycle: 1,
  }
  assert.equal(calculateRequiredVotes(pool3, withdrawalProp), 2)

  // EvictMember with targetIsVoter = true subtracts target voter from base voting members
  // 3 voters - 1 = 2 active members. 2 * 1 cycle = 2. ceil(2 * 6667 / 10000) = 2
  const evictProp = {
    action: { evictMember: { target: new PublicKey('11111111111111111111111111111111') } },
    voteThreshold: 6667,
    votingCycle: 1,
    deadlineCycle: 1,
    targetIsVoter: true,
  }
  assert.equal(calculateRequiredVotes(pool3, evictProp), 2)

  // ClosePool with 0 funded members falls back to memberCount
  const poolUnfunded = {
    votingMemberCount: 0,
    fundedMemberCount: 0,
    memberCount: 4,
    voteThreshold: 5001,
  }
  const closeProp = {
    action: { closePool: {} },
    voteThreshold: 5001,
    votingCycle: 1,
    deadlineCycle: 1,
  }
  // 4 members * 1 cycle * 5001 bps = ceil(20004 / 10000) = 3
  assert.equal(calculateRequiredVotes(poolUnfunded, closeProp), 3)
})

test('Early threshold resolution resolves proposals before deadline in threshold_met mode', () => {
  const pool = {
    votingMemberCount: 3,
    fundedMemberCount: 3,
    memberCount: 3,
    voteThreshold: 5001,
    isLocked: false,
  }

  // ApproveWithdrawal requires 5 votes in 3-member pool over 3 cycles (ceil(3 * 3 * 5001 / 10000) = 5)
  const propThresholdMet = {
    state: { open: {} },
    action: { approveWithdrawal: {} },
    voteThreshold: 5001,
    executionMode: 'threshold_met',
    votingCycle: 1,
    deadlineCycle: 3, // Deadline in future
    yesVotes: 5,
    noVotes: 0,
  }

  // Current cycle is 1 (deadline 3 has NOT arrived)
  const currentCycle = new BN(1)

  // Threshold is met: 5 >= 5 and 5 > 0 -> passed!
  assert.equal(isProposalPassed(pool, propThresholdMet), true)
  assert.equal(shouldResolveProposal(pool, propThresholdMet, currentCycle), true)

  // If votes insufficient: 4 < 5 -> should not resolve early
  const propInsufficient = { ...propThresholdMet, yesVotes: 4 }
  assert.equal(isProposalPassed(pool, propInsufficient), false)
  assert.equal(shouldResolveProposal(pool, propInsufficient, currentCycle), false)

  // If on_deadline mode, even if passed, must NOT resolve until deadline cycle
  const propOnDeadline = { ...propThresholdMet, executionMode: 'on_deadline' }
  assert.equal(shouldResolveProposal(pool, propOnDeadline, currentCycle), false)
  // When cycle reaches deadline:
  assert.equal(shouldResolveProposal(pool, propOnDeadline, new BN(3)), true)

  // If pool is locked, non-ClosePool proposals must NOT resolve
  const poolLocked = { ...pool, isLocked: true }
  assert.equal(shouldResolveProposal(poolLocked, propThresholdMet, currentCycle), false)
  const closePropLocked = { ...propThresholdMet, action: { closePool: {} } }
  assert.equal(shouldResolveProposal(poolLocked, closePropLocked, currentCycle), true)
})

test('Multi-cycle rollover progression cranks successive cycles correctly', () => {
  let pool = {
    currentCycle: new BN(0),
    cycleDurationSeconds: new BN(3600),
    cycleStartedAt: new BN(1000),
    headMember: null,
    rolloverCursor: null,
  }

  // Cycle 0 -> 1
  let timing = getPoolTiming(pool)
  assert.equal(timing.nextStart.toNumber(), 4600)

  // Simulate roll to cycle 1
  pool = {
    ...pool,
    currentCycle: new BN(1),
    cycleStartedAt: timing.nextStart,
  }

  // Cycle 1 -> 2
  timing = getPoolTiming(pool)
  assert.equal(timing.currentCycle.toNumber(), 1)
  assert.equal(timing.cycleStartedAt.toNumber(), 4600)
  assert.equal(timing.nextStart.toNumber(), 8200)

  // Simulate roll to cycle 2
  pool = {
    ...pool,
    currentCycle: new BN(2),
    cycleStartedAt: timing.nextStart,
  }

  // Cycle 2 -> 3
  timing = getPoolTiming(pool)
  assert.equal(timing.currentCycle.toNumber(), 2)
  assert.equal(timing.cycleStartedAt.toNumber(), 8200)
  assert.equal(timing.nextStart.toNumber(), 11800)
})

test('Negative & Escalation Tests: rejects and escalates on invalid parameters without suppressing errors', async () => {
  // getPoolTiming parameter escalation
  assert.throws(() => getPoolTiming(null), /Pool object is required/)
  assert.throws(() => getPoolTiming({}), /Pool missing currentCycle/)
  assert.throws(() => getPoolTiming({ currentCycle: 0 }), /Pool missing cycleDurationSeconds/)
  assert.throws(() => getPoolTiming({ currentCycle: 0, cycleDurationSeconds: 10 }), /Pool missing cycleStartedAt/)

  // calculateRequiredVotes parameter escalation
  assert.throws(() => calculateRequiredVotes(null, {}), /Pool object required/)
  assert.throws(() => calculateRequiredVotes({}, null), /Proposal object required/)
  assert.throws(() => calculateRequiredVotes({ voteThreshold: 5001 }, { action: { closePool: {} }, voteThreshold: 50 }), /Invalid voteThreshold/)
  assert.throws(() => calculateRequiredVotes({ voteThreshold: 5001 }, { action: { closePool: {} }, voteThreshold: 10001 }), /Invalid voteThreshold/)
  assert.throws(() => calculateRequiredVotes({ voteThreshold: 5001 }, { voteThreshold: 5001 }), /Proposal missing action/)

  // traverseMemberChain escalation on cycle
  const pkA = Keypair.generate().publicKey
  const pkB = Keypair.generate().publicKey
  const pkMissing = Keypair.generate().publicKey
  const memberA = { publicKey: pkA, account: { nextMember: pkB } }
  const memberB = { publicKey: pkB, account: { nextMember: pkA } } // Cycle!
  assert.throws(() => traverseMemberChain(pkA, [memberA, memberB]), /Cycle detected/)

  // traverseMemberChain escalation on missing member in chain
  const memberBroken = { publicKey: pkA, account: { nextMember: pkMissing } }
  assert.throws(() => traverseMemberChain(pkA, [memberBroken]), /not found in pool members list/)

  // buildRolloverRemainingAccounts escalation on invalid chunkSize
  const validPool = {
    currentCycle: new BN(1),
    cycleDurationSeconds: new BN(3600),
    cycleStartedAt: new BN(1000),
    headMember: null,
  }
  assert.throws(() => buildRolloverRemainingAccounts(pkA, validPool, [], [], { chunkSize: 0 }), /Invalid chunkSize/)
  assert.throws(() => buildRolloverRemainingAccounts(pkA, validPool, [], [], { chunkSize: -10 }), /Invalid chunkSize/)

  // processPoolCycleRoll escalation on null program when elapsed
  const elapsedPoolItem = {
    publicKey: pkA,
    account: {
      currentCycle: new BN(1),
      cycleDurationSeconds: new BN(1),
      cycleStartedAt: new BN(100),
    },
  }
  await assert.rejects(
    () => processPoolCycleRoll(null, elapsedPoolItem, null, { nowSec: 500 }),
    /Program is required to execute cycle roll/
  )

  // executeAction('roll_cycle') escalation on invalid chunkSize
  await assert.rejects(
    () => executeAction('roll_cycle', { poolAddress: pkA.toBase58(), chunkSize: -1 }),
    /Invalid chunkSize: must be a positive number/
  )
})
