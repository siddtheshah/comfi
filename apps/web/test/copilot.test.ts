import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_CAPABILITY_TOGGLES,
  DEFAULT_COPILOT_CONFIG,
  appendAuditEntry,
  clearAuditLog,
  evaluatePoolGovernance,
  isHighImpactProposal,
  isRoutineProposal,
  loadAuditLog,
  loadCopilotConfig,
  processCopilotQuery,
  saveCopilotConfig,
  validateAuditEntry,
  validateAutonomyTier,
  validateCapabilityToggles,
  validateCopilotConfig,
} from '../src/copilot-engine.ts'
import type {
  CopilotConfig,
  CopilotPoolSnapshot,
  DecisionAuditEntry,
} from '../src/copilot-types.ts'

function createMockStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

test('validateAutonomyTier accepts valid tiers and escalates on invalid tiers', () => {
  assert.doesNotThrow(() => validateAutonomyTier('advisory'))
  assert.doesNotThrow(() => validateAutonomyTier('supervised'))
  assert.doesNotThrow(() => validateAutonomyTier('autonomous'))

  assert.throws(() => validateAutonomyTier('ultra_risk'), {
    message: /Invalid autonomy tier/,
  })
  assert.throws(() => validateAutonomyTier(''), {
    message: /Invalid autonomy tier/,
  })
  assert.throws(() => validateAutonomyTier(null), {
    message: /Invalid autonomy tier/,
  })
  assert.throws(() => validateAutonomyTier(123), {
    message: /Invalid autonomy tier/,
  })
})

test('validateCapabilityToggles rejects malformed toggles and missing keys', () => {
  assert.doesNotThrow(() => validateCapabilityToggles(DEFAULT_CAPABILITY_TOGGLES))

  assert.throws(() => validateCapabilityToggles(null), {
    message: /Invalid capability toggles/,
  })
  assert.throws(() => validateCapabilityToggles({ autoRollCycle: 'yes' }), {
    message: /Invalid capability toggle/,
  })
  assert.throws(() => validateCapabilityToggles({
    autoRollCycle: true,
    autoExecutePassedProposals: true,
    autoVouchCandidates: true,
    // missing autoVoteLineageYes and autoClaimSurplusRefund
  }), {
    message: /Invalid capability toggle/,
  })
})

test('validateCopilotConfig enforces valid structure and escalates on bad fields', () => {
  assert.doesNotThrow(() => validateCopilotConfig(DEFAULT_COPILOT_CONFIG))

  assert.throws(() => validateCopilotConfig(null), {
    message: /Invalid Copilot configuration/,
  })
  assert.throws(() => validateCopilotConfig({
    tier: 'advisory',
    toggles: DEFAULT_CAPABILITY_TOGGLES,
    autoCrankEnabled: 'not-a-bool',
  }), {
    message: /Invalid autoCrankEnabled/,
  })
})

test('validateAuditEntry validates entry structure and score boundaries', () => {
  const validEntry: DecisionAuditEntry = {
    id: 'test-1',
    timestamp: 1700000000000,
    tier: 'supervised',
    actionType: 'roll_cycle',
    title: 'Test Roll',
    rationale: 'Overdue deadline test',
    confidenceScore: 95,
    status: 'executed',
  }
  assert.doesNotThrow(() => validateAuditEntry(validEntry))

  // Out of bounds confidence scores
  assert.throws(() => validateAuditEntry({ ...validEntry, confidenceScore: -5 }), {
    message: /Invalid confidenceScore/,
  })
  assert.throws(() => validateAuditEntry({ ...validEntry, confidenceScore: 105 }), {
    message: /Invalid confidenceScore/,
  })
  assert.throws(() => validateAuditEntry({ ...validEntry, confidenceScore: NaN }), {
    message: /Invalid confidenceScore/,
  })

  // Missing id, bad timestamp, bad status
  assert.throws(() => validateAuditEntry({ ...validEntry, id: '' }), {
    message: /Missing or empty audit entry id/,
  })
  assert.throws(() => validateAuditEntry({ ...validEntry, timestamp: 0 }), {
    message: /Invalid audit entry timestamp/,
  })
  assert.throws(() => validateAuditEntry({ ...validEntry, status: 'unrecognized' as any }), {
    message: /Invalid audit entry status/,
  })
})

test('config storage loads defaults and persists updates', () => {
  const storage = createMockStorage()
  const initial = loadCopilotConfig(storage)
  assert.equal(initial.tier, 'supervised')
  assert.equal(initial.toggles.autoRollCycle, true)

  const customConfig: CopilotConfig = {
    tier: 'autonomous',
    toggles: {
      ...DEFAULT_CAPABILITY_TOGGLES,
      autoRollCycle: false,
    },
    autoCrankEnabled: false,
  }
  saveCopilotConfig(customConfig, storage)

  const reloaded = loadCopilotConfig(storage)
  assert.equal(reloaded.tier, 'autonomous')
  assert.equal(reloaded.toggles.autoRollCycle, false)
  assert.equal(reloaded.autoCrankEnabled, false)
})

test('audit log storage appends entries and clears on command', () => {
  const storage = createMockStorage()
  assert.deepEqual(loadAuditLog(storage), [])

  const entry1: DecisionAuditEntry = {
    id: 'audit-1',
    timestamp: 1700000001000,
    tier: 'supervised',
    actionType: 'roll_cycle',
    title: 'Cycle 1 Rolled',
    rationale: 'Cycle duration expired',
    confidenceScore: 98,
    status: 'executed',
  }
  const entry2: DecisionAuditEntry = {
    id: 'audit-2',
    timestamp: 1700000002000,
    tier: 'advisory',
    actionType: 'execute_proposal',
    title: 'Proposal #2 Ready',
    rationale: 'Threshold satisfied',
    confidenceScore: 92,
    status: 'recommended',
  }

  appendAuditEntry(entry1, storage)
  const afterSecond = appendAuditEntry(entry2, storage)
  assert.equal(afterSecond.length, 2)
  assert.equal(afterSecond[0].id, 'audit-2') // latest first

  clearAuditLog(storage)
  assert.deepEqual(loadAuditLog(storage), [])
})

test('proposal impact categorization correctly distinguishes routine vs high-impact', () => {
  assert.equal(isRoutineProposal('SetSpenderLimit'), true)
  assert.equal(isRoutineProposal('ApproveWithdrawal'), true)
  assert.equal(isRoutineProposal('EvictMember'), false)

  assert.equal(isHighImpactProposal('ClosePool'), true)
  assert.equal(isHighImpactProposal('EvictMember'), true)
  assert.equal(isHighImpactProposal('ConfigurationModification'), true)
  assert.equal(isHighImpactProposal('SetSpenderLimit'), false)

  assert.throws(() => isRoutineProposal(''), { message: /Missing actionType/ })
  assert.throws(() => isHighImpactProposal(''), { message: /Missing actionType/ })
})

test('evaluatePoolGovernance escalates on invalid pool, config or timestamp', () => {
  assert.throws(() => evaluatePoolGovernance(null as any, DEFAULT_COPILOT_CONFIG), {
    message: /Missing or invalid pool parameter/,
  })
  assert.throws(() => evaluatePoolGovernance({} as any, DEFAULT_COPILOT_CONFIG), {
    message: /Pool object must contain a valid id/,
  })
  assert.throws(() => evaluatePoolGovernance({ id: 'pool-1', name: 'Pool 1', memberCount: 1, memberCap: 10, currentCycle: 1 }, null as any), {
    message: /Invalid Copilot configuration/,
  })
  assert.throws(() => evaluatePoolGovernance({ id: 'pool-1', name: 'Pool 1', memberCount: 1, memberCap: 10, currentCycle: 1 }, DEFAULT_COPILOT_CONFIG, -1), {
    message: /Invalid nowSeconds timestamp/,
  })
})

test('evaluatePoolGovernance Tier 1 (Advisory Mode) issues recommendations without executing', () => {
  const now = 10000
  const pool: CopilotPoolSnapshot = {
    id: 'pool-1',
    name: 'Mutual Aid',
    memberCount: 5,
    memberCap: 10,
    currentCycle: 2,
    cycleStartedAt: 8000,
    cycleDurationSeconds: 1000, // expired at 9000
    isLocked: true,
    proposals: [
      {
        id: 1,
        actionType: 'SetSpenderLimit',
        state: 'Open',
        yesVotes: 4,
        noVotes: 0,
        voteThreshold: 3, // passed!
        isPassed: true,
        isExecutable: true,
        isRoutine: true,
      },
    ],
  }

  const advisoryConfig: CopilotConfig = {
    ...DEFAULT_COPILOT_CONFIG,
    tier: 'advisory',
  }

  const decisions = evaluatePoolGovernance(pool, advisoryConfig, now)
  assert.equal(decisions.length, 3)

  // 1. Quorum locked alert
  const lockedAlert = decisions.find(d => d.actionType === 'quorum_alert')
  assert.ok(lockedAlert)
  assert.equal(lockedAlert?.status, 'recommended')
  assert.equal(lockedAlert?.confidenceScore, 98)

  // 2. Overdue cycle roll recommendation
  const cycleRoll = decisions.find(d => d.actionType === 'roll_cycle')
  assert.ok(cycleRoll)
  assert.equal(cycleRoll?.status, 'recommended')
  assert.equal(cycleRoll?.confidenceScore, 95)

  // 3. Proposal execution recommendation
  const propExec = decisions.find(d => d.actionType === 'execute_proposal')
  assert.ok(propExec)
  assert.equal(propExec?.status, 'recommended')
  assert.equal(propExec?.confidenceScore, 94)
})

test('evaluatePoolGovernance Tier 2 (Supervised Automation) auto-executes routine and prompts high-impact', () => {
  const now = 10000
  const pool: CopilotPoolSnapshot = {
    id: 'pool-2',
    name: 'Supervised Pool',
    memberCount: 8,
    memberCap: 12,
    currentCycle: 4,
    cycleStartedAt: 7000,
    cycleDurationSeconds: 2000, // expired at 9000
    proposals: [
      {
        id: 10,
        actionType: 'SetSpenderLimit',
        state: 'Executable',
        yesVotes: 5,
        noVotes: 0,
        voteThreshold: 4,
        isPassed: true,
        isExecutable: true,
        isRoutine: true,
      },
      {
        id: 11,
        actionType: 'EvictMember',
        state: 'Executable',
        yesVotes: 6,
        noVotes: 0,
        voteThreshold: 5,
        isPassed: true,
        isExecutable: true,
        isRoutine: false,
      },
      {
        id: 12,
        actionType: 'AdmitMember',
        state: 'Open',
        yesVotes: 1,
        noVotes: 0,
        voteThreshold: 4,
        isPassed: false,
        isExecutable: false,
        isRoutine: false,
        vouchedBy: 'So11111111111111111111111111111111111111112',
      },
    ],
  }

  const supervisedConfig: CopilotConfig = {
    ...DEFAULT_COPILOT_CONFIG,
    tier: 'supervised',
    toggles: {
      ...DEFAULT_CAPABILITY_TOGGLES,
      autoRollCycle: true,
      autoExecutePassedProposals: true,
      autoVoteLineageYes: true,
    },
  }

  const decisions = evaluatePoolGovernance(pool, supervisedConfig, now)

  // Overdue cycle auto-rolls
  const cycleRoll = decisions.find(d => d.actionType === 'roll_cycle')
  assert.ok(cycleRoll)
  assert.equal(cycleRoll?.status, 'executed')
  assert.equal(cycleRoll?.confidenceScore, 98)

  // Routine proposal #10 auto-executes
  const routineProp = decisions.find(d => d.proposalId === 10)
  assert.ok(routineProp)
  assert.equal(routineProp?.status, 'executed')
  assert.equal(routineProp?.confidenceScore, 96)

  // High-impact proposal #11 prompts approval
  const highImpactProp = decisions.find(d => d.proposalId === 11)
  assert.ok(highImpactProp)
  assert.equal(highImpactProp?.status, 'pending_approval')
  assert.equal(highImpactProp?.confidenceScore, 92)

  // Lineage candidate auto-votes YES
  const lineageVote = decisions.find(d => d.proposalId === 12 && d.actionType === 'vote_proposal')
  assert.ok(lineageVote)
  assert.equal(lineageVote?.status, 'executed')
  assert.equal(lineageVote?.confidenceScore, 93)
})

test('evaluatePoolGovernance Tier 3 (Autonomous Delegation) cranks cycle and executes passed proposals', () => {
  const now = 20000
  const pool: CopilotPoolSnapshot = {
    id: 'pool-3',
    name: 'Autonomous Pool',
    memberCount: 6,
    memberCap: 10,
    currentCycle: 5,
    cycleStartedAt: 15000,
    cycleDurationSeconds: 3000, // expired at 18000
    isClosing: true,
    hasPendingRefund: true,
    proposals: [
      {
        id: 20,
        actionType: 'ClosePool',
        state: 'Executable',
        yesVotes: 5,
        noVotes: 0,
        voteThreshold: 4,
        isPassed: true,
        isExecutable: true,
        isRoutine: false,
      },
    ],
  }

  const autonomousConfig: CopilotConfig = {
    ...DEFAULT_COPILOT_CONFIG,
    tier: 'autonomous',
    toggles: {
      ...DEFAULT_CAPABILITY_TOGGLES,
      autoRollCycle: true,
      autoExecutePassedProposals: true,
      autoClaimSurplusRefund: true,
    },
  }

  const decisions = evaluatePoolGovernance(pool, autonomousConfig, now)

  const cycleRoll = decisions.find(d => d.actionType === 'roll_cycle')
  assert.ok(cycleRoll)
  assert.equal(cycleRoll?.status, 'executed')
  assert.equal(cycleRoll?.confidenceScore, 99)

  const propExec = decisions.find(d => d.actionType === 'execute_proposal')
  assert.ok(propExec)
  assert.equal(propExec?.status, 'executed')
  assert.equal(propExec?.confidenceScore, 98)

  const refundClaim = decisions.find(d => d.actionType === 'claim_refund')
  assert.ok(refundClaim)
  assert.equal(refundClaim?.status, 'executed')
  assert.equal(refundClaim?.confidenceScore, 99)
})

test('processCopilotQuery handles quorum, proposals, cycle, tier, and help queries', () => {
  const pool: CopilotPoolSnapshot = {
    id: 'pool-qa',
    name: 'QA Community Pool',
    memberCount: 7,
    memberCap: 10,
    currentCycle: 3,
    voteThreshold: 4,
    cycleStartedAt: 1000,
    cycleDurationSeconds: 86400,
    proposals: [
      {
        id: 1,
        actionType: 'SetSpenderLimit',
        state: 'Executable',
        yesVotes: 5,
        noVotes: 0,
        voteThreshold: 4,
        isPassed: true,
        isExecutable: true,
        isRoutine: true,
      },
    ],
  }

  // Quorum query
  const quorumRes = processCopilotQuery('What is our quorum status?', pool)
  assert.equal(quorumRes.sender, 'assistant')
  assert.match(quorumRes.text, /7 of 10 active members/)
  assert.equal(quorumRes.confidenceScore, 96)

  // Proposals query
  const propsRes = processCopilotQuery('Are there pending proposals to vote on?', pool)
  assert.match(propsRes.text, /Proposal #1/)
  assert.equal(propsRes.actionSuggestion?.actionType, 'execute_proposal')
  assert.equal(propsRes.actionSuggestion?.proposalId, 1)

  // Execute query
  const execRes = processCopilotQuery('Execute passed proposals', pool)
  assert.match(execRes.text, /Proposal #1/)
  assert.equal(execRes.actionSuggestion?.actionType, 'execute_proposal')

  // Cycle query
  const cycleRes = processCopilotQuery('What is our cycle deadline?', pool)
  assert.match(cycleRes.text, /Cycle #3/)

  // Tier query
  const tierRes = processCopilotQuery('What is my current autonomy tier?')
  assert.match(tierRes.text, /Current Copilot Mode/)

  // Help query
  const helpRes = processCopilotQuery('Help')
  assert.match(helpRes.text, /ComFi Copilot/)
})

test('processCopilotQuery escalates on empty or non-string query', () => {
  assert.throws(() => processCopilotQuery(''), {
    message: /Missing or empty query string/,
  })
  assert.throws(() => processCopilotQuery('   '), {
    message: /Missing or empty query string/,
  })
  assert.throws(() => processCopilotQuery(null as any), {
    message: /Missing or empty query string/,
  })
})
