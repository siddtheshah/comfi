import type {
  AutonomyTier,
  CapabilityToggles,
  CopilotConfig,
  CopilotMessage,
  CopilotPoolSnapshot,
  DecisionAuditEntry,
} from './copilot-types'

export const DEFAULT_CAPABILITY_TOGGLES: CapabilityToggles = {
  autoRollCycle: true,
  autoExecutePassedProposals: true,
  autoVouchCandidates: false,
  autoVoteLineageYes: true,
  autoClaimSurplusRefund: false,
}

export const DEFAULT_COPILOT_CONFIG: CopilotConfig = {
  tier: 'supervised',
  toggles: { ...DEFAULT_CAPABILITY_TOGGLES },
  autoCrankEnabled: true,
}

const STORAGE_CONFIG_KEY = 'comfi_copilot_config_v1'
const STORAGE_AUDIT_KEY = 'comfi_copilot_audit_v1'

export function validateAutonomyTier(tier: unknown): asserts tier is AutonomyTier {
  if (tier !== 'advisory' && tier !== 'supervised' && tier !== 'autonomous') {
    throw new Error(`Invalid autonomy tier: '${String(tier)}'. Must be 'advisory', 'supervised', or 'autonomous'.`)
  }
}

export function validateCapabilityToggles(toggles: unknown): asserts toggles is CapabilityToggles {
  if (!toggles || typeof toggles !== 'object') {
    throw new Error('Invalid capability toggles: expected an object.')
  }
  const t = toggles as Record<string, unknown>
  const requiredKeys: (keyof CapabilityToggles)[] = [
    'autoRollCycle',
    'autoExecutePassedProposals',
    'autoVouchCandidates',
    'autoVoteLineageYes',
    'autoClaimSurplusRefund',
  ]
  for (const key of requiredKeys) {
    if (typeof t[key] !== 'boolean') {
      throw new Error(`Invalid capability toggle '${key}': expected boolean, got ${typeof t[key]}.`)
    }
  }
}

export function validateCopilotConfig(config: unknown): asserts config is CopilotConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid Copilot configuration: expected object.')
  }
  const c = config as Record<string, unknown>
  validateAutonomyTier(c.tier)
  validateCapabilityToggles(c.toggles)
  if (typeof c.autoCrankEnabled !== 'boolean') {
    throw new Error(`Invalid autoCrankEnabled: expected boolean, got ${typeof c.autoCrankEnabled}.`)
  }
}

export function validateAuditEntry(entry: unknown): asserts entry is DecisionAuditEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid audit entry: expected object.')
  }
  const e = entry as Record<string, unknown>
  if (typeof e.id !== 'string' || !e.id.trim()) {
    throw new Error('Missing or empty audit entry id.')
  }
  if (typeof e.timestamp !== 'number' || isNaN(e.timestamp) || e.timestamp <= 0) {
    throw new Error('Invalid audit entry timestamp.')
  }
  validateAutonomyTier(e.tier)
  if (typeof e.title !== 'string' || !e.title.trim()) {
    throw new Error('Missing or empty audit entry title.')
  }
  if (typeof e.rationale !== 'string' || !e.rationale.trim()) {
    throw new Error('Missing or empty audit entry rationale.')
  }
  if (typeof e.confidenceScore !== 'number' || isNaN(e.confidenceScore) || e.confidenceScore < 0 || e.confidenceScore > 100) {
    throw new Error(`Invalid confidenceScore: expected number between 0 and 100, got ${String(e.confidenceScore)}.`)
  }
  if (e.status !== 'executed' && e.status !== 'recommended' && e.status !== 'pending_approval' && e.status !== 'blocked') {
    throw new Error(`Invalid audit entry status: '${String(e.status)}'.`)
  }
}

export function loadCopilotConfig(storage?: Storage): CopilotConfig {
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!s) return { ...DEFAULT_COPILOT_CONFIG, toggles: { ...DEFAULT_CAPABILITY_TOGGLES } }

  const raw = s.getItem(STORAGE_CONFIG_KEY)
  if (!raw) return { ...DEFAULT_COPILOT_CONFIG, toggles: { ...DEFAULT_CAPABILITY_TOGGLES } }

  const parsed = JSON.parse(raw)
  validateCopilotConfig(parsed)
  return parsed
}

export function saveCopilotConfig(config: CopilotConfig, storage?: Storage): void {
  validateCopilotConfig(config)
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!s) return
  s.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config))
}

export function loadAuditLog(storage?: Storage): DecisionAuditEntry[] {
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!s) return []

  const raw = s.getItem(STORAGE_AUDIT_KEY)
  if (!raw) return []

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('Corrupted audit log storage: expected array.')
  }
  for (const item of parsed) {
    validateAuditEntry(item)
  }
  return parsed
}

export function appendAuditEntry(entry: DecisionAuditEntry, storage?: Storage, maxEntries = 100): DecisionAuditEntry[] {
  validateAuditEntry(entry)
  const existing = loadAuditLog(storage)
  const updated = [entry, ...existing].slice(0, maxEntries)
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (s) {
    s.setItem(STORAGE_AUDIT_KEY, JSON.stringify(updated))
  }
  return updated
}

export function clearAuditLog(storage?: Storage): void {
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (s) {
    s.removeItem(STORAGE_AUDIT_KEY)
  }
}

export function isRoutineProposal(actionType: string): boolean {
  if (!actionType) throw new Error('Missing actionType in isRoutineProposal check.')
  const routineActions = ['SetSpenderLimit', 'approve_withdrawal', 'ApproveWithdrawal']
  return routineActions.includes(actionType)
}

export function isHighImpactProposal(actionType: string): boolean {
  if (!actionType) throw new Error('Missing actionType in isHighImpactProposal check.')
  const highImpact = ['ClosePool', 'EvictMember', 'ConfigurationModification']
  return highImpact.includes(actionType)
}

/**
 * Autonomous and delegated decision engine that continuously audits pool governance,
 * proposals, cycle deadlines, quorum health, and member vouches.
 */
export function evaluatePoolGovernance(
  pool: CopilotPoolSnapshot,
  config: CopilotConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): DecisionAuditEntry[] {
  if (!pool || typeof pool !== 'object') {
    throw new Error('Missing or invalid pool parameter in evaluatePoolGovernance.')
  }
  if (!pool.id) {
    throw new Error('Pool object must contain a valid id.')
  }
  validateCopilotConfig(config)
  if (typeof nowSeconds !== 'number' || isNaN(nowSeconds) || nowSeconds <= 0) {
    throw new Error(`Invalid nowSeconds timestamp: ${String(nowSeconds)}.`)
  }

  const decisions: DecisionAuditEntry[] = []

  // 1. Quorum Health & Lock Status Evaluation
  if (pool.isLocked) {
    decisions.push({
      id: `audit-quorum-locked-${pool.id}-${nowSeconds}`,
      timestamp: nowSeconds * 1000,
      tier: config.tier,
      actionType: 'quorum_alert',
      title: 'Quorum Failure: Pool Is Locked',
      rationale: `Pool #${pool.id} is locked due to insufficient active voter quorum. Immediate member participation or rollover intervention is required.`,
      confidenceScore: 98,
      status: 'recommended',
      poolId: pool.id,
      poolAddress: pool.address,
      details: { memberCount: pool.memberCount, memberCap: pool.memberCap },
    })
  }

  // 2. Cycle Expiration and Roll Evaluation
  if (pool.cycleStartedAt != null && pool.cycleDurationSeconds != null && pool.cycleDurationSeconds > 0) {
    const deadline = pool.cycleStartedAt + pool.cycleDurationSeconds
    const isOverdue = nowSeconds >= deadline
    const overdueSeconds = isOverdue ? nowSeconds - deadline : 0

    if (isOverdue) {
      if (config.tier === 'advisory') {
        decisions.push({
          id: `audit-cycle-roll-${pool.id}-${nowSeconds}`,
          timestamp: nowSeconds * 1000,
          tier: config.tier,
          actionType: 'roll_cycle',
          title: `Cycle Overdue by ${Math.floor(overdueSeconds / 60)}m`,
          rationale: `Current cycle #${pool.currentCycle} passed deadline at ${new Date(deadline * 1000).toLocaleTimeString()}. Advisory mode recommends rolling cycle to refresh member allowances and advance pool schedule.`,
          confidenceScore: 95,
          status: 'recommended',
          poolId: pool.id,
          poolAddress: pool.address,
          details: { currentCycle: pool.currentCycle, overdueSeconds },
        })
      } else if (config.tier === 'supervised') {
        if (config.toggles.autoRollCycle) {
          decisions.push({
            id: `audit-cycle-roll-${pool.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'roll_cycle',
            title: `Auto-Rolled Overdue Cycle #${pool.currentCycle}`,
            rationale: `Overdue cycle (${Math.floor(overdueSeconds / 60)}m elapsed) detected. Supervised automation crank executed cycle advance per user toggle.`,
            confidenceScore: 98,
            status: 'executed',
            poolId: pool.id,
            poolAddress: pool.address,
            details: { currentCycle: pool.currentCycle, overdueSeconds },
          })
        } else {
          decisions.push({
            id: `audit-cycle-roll-${pool.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'roll_cycle',
            title: `Cycle Roll Overdue (${Math.floor(overdueSeconds / 60)}m)`,
            rationale: `Cycle is overdue but autoRollCycle toggle is disabled. Waiting for member manual crank.`,
            confidenceScore: 90,
            status: 'recommended',
            poolId: pool.id,
            poolAddress: pool.address,
          })
        }
      } else if (config.tier === 'autonomous') {
        if (config.toggles.autoRollCycle) {
          decisions.push({
            id: `audit-cycle-roll-${pool.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'roll_cycle',
            title: `Autonomous Crank: Advanced Cycle #${pool.currentCycle}`,
            rationale: `Autonomous agent detected overdue cycle deadline. Cranked cycle advance transaction without requiring user manual intervention.`,
            confidenceScore: 99,
            status: 'executed',
            poolId: pool.id,
            poolAddress: pool.address,
            details: { currentCycle: pool.currentCycle, overdueSeconds },
          })
        } else {
          decisions.push({
            id: `audit-cycle-roll-${pool.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'roll_cycle',
            title: `Autonomous Cycle Crank Blocked`,
            rationale: `Auto-roll capability toggle is turned OFF in Copilot settings.`,
            confidenceScore: 88,
            status: 'blocked',
            poolId: pool.id,
            poolAddress: pool.address,
          })
        }
      }
    }
  }

  // 3. Proposal Lifecycle & Execution Evaluation
  if (pool.proposals && pool.proposals.length > 0) {
    for (const prop of pool.proposals) {
      const isPassed = prop.isPassed || prop.yesVotes >= prop.voteThreshold
      const isExecutable = prop.state === 'Executable' || (isPassed && prop.state === 'Open')

      if (isExecutable && prop.state !== 'Executed' && prop.state !== 'Rejected') {
        const isRoutine = prop.isRoutine || isRoutineProposal(prop.actionType)
        const isHighImpact = isHighImpactProposal(prop.actionType)

        if (config.tier === 'advisory') {
          decisions.push({
            id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'execute_proposal',
            title: `Proposal #${prop.id} Ready: ${prop.actionType}`,
            rationale: `Proposal #${prop.id} reached required threshold (${prop.yesVotes}/${prop.voteThreshold} votes). Advisory mode recommends 1-click execution.`,
            confidenceScore: 94,
            status: 'recommended',
            proposalId: prop.id,
            poolId: pool.id,
            poolAddress: pool.address,
          })
        } else if (config.tier === 'supervised') {
          if (isHighImpact) {
            decisions.push({
              id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
              timestamp: nowSeconds * 1000,
              tier: config.tier,
              actionType: 'execute_proposal',
              title: `High-Impact Proposal #${prop.id}: Approval Required`,
              rationale: `Proposal #${prop.id} is a high-impact governance action (${prop.actionType}). Supervised tier requires user sign-off prior to execution.`,
              confidenceScore: 92,
              status: 'pending_approval',
              proposalId: prop.id,
              poolId: pool.id,
              poolAddress: pool.address,
            })
          } else if (config.toggles.autoExecutePassedProposals) {
            decisions.push({
              id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
              timestamp: nowSeconds * 1000,
              tier: config.tier,
              actionType: 'execute_proposal',
              title: `Auto-Executed Routine Proposal #${prop.id}`,
              rationale: `Routine proposal #${prop.id} (${prop.actionType}) satisfied threshold (${prop.yesVotes}/${prop.voteThreshold}). Executed autonomously under supervised policy.`,
              confidenceScore: 96,
              status: 'executed',
              proposalId: prop.id,
              poolId: pool.id,
              poolAddress: pool.address,
            })
          } else {
            decisions.push({
              id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
              timestamp: nowSeconds * 1000,
              tier: config.tier,
              actionType: 'execute_proposal',
              title: `Proposal #${prop.id} Ready to Execute`,
              rationale: `Proposal #${prop.id} passed threshold, but auto-execute toggle is disabled. Recommended for manual execution.`,
              confidenceScore: 90,
              status: 'recommended',
              proposalId: prop.id,
              poolId: pool.id,
              poolAddress: pool.address,
            })
          }
        } else if (config.tier === 'autonomous') {
          if (config.toggles.autoExecutePassedProposals) {
            decisions.push({
              id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
              timestamp: nowSeconds * 1000,
              tier: config.tier,
              actionType: 'execute_proposal',
              title: `Autonomous Execution: Proposal #${prop.id}`,
              rationale: `Autonomous delegation dispatched execution instruction for passed proposal #${prop.id} (${prop.actionType}) meeting threshold requirements.`,
              confidenceScore: 98,
              status: 'executed',
              proposalId: prop.id,
              poolId: pool.id,
              poolAddress: pool.address,
            })
          } else {
            decisions.push({
              id: `audit-prop-exec-${prop.id}-${nowSeconds}`,
              timestamp: nowSeconds * 1000,
              tier: config.tier,
              actionType: 'execute_proposal',
              title: `Autonomous Execution Held: Proposal #${prop.id}`,
              rationale: `Proposal #${prop.id} is executable, but auto-execute capability is disabled in settings.`,
              confidenceScore: 86,
              status: 'blocked',
              proposalId: prop.id,
              poolId: pool.id,
              poolAddress: pool.address,
            })
          }
        }
      }

      // Member Lineage Auto-Vote Check
      if (prop.state === 'Open' && prop.actionType === 'AdmitMember' && prop.vouchedBy && config.toggles.autoVoteLineageYes) {
        if (config.tier === 'supervised' || config.tier === 'autonomous') {
          decisions.push({
            id: `audit-prop-vote-${prop.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'vote_proposal',
            title: `Auto-Voted YES: Vouched Candidate #${prop.id}`,
            rationale: `Candidate admission #${prop.id} was vouched by lineage partner ${prop.vouchedBy.slice(0, 4)}…${prop.vouchedBy.slice(-4)}. Auto-vote YES cast per lineage policy.`,
            confidenceScore: 93,
            status: 'executed',
            proposalId: prop.id,
            poolId: pool.id,
            poolAddress: pool.address,
          })
        } else {
          decisions.push({
            id: `audit-prop-vote-${prop.id}-${nowSeconds}`,
            timestamp: nowSeconds * 1000,
            tier: config.tier,
            actionType: 'vote_proposal',
            title: `Recommend YES on Vouched Lineage Candidate #${prop.id}`,
            rationale: `Candidate admission was vouched within your member network. Advisory mode recommends casting a YES vote.`,
            confidenceScore: 91,
            status: 'recommended',
            proposalId: prop.id,
            poolId: pool.id,
            poolAddress: pool.address,
          })
        }
      }
    }
  }

  // 4. Pool Closure & Surplus Refund Evaluation
  if (pool.isClosing && pool.hasPendingRefund) {
    if (config.tier === 'autonomous' && config.toggles.autoClaimSurplusRefund) {
      decisions.push({
        id: `audit-closure-refund-${pool.id}-${nowSeconds}`,
        timestamp: nowSeconds * 1000,
        tier: config.tier,
        actionType: 'claim_refund',
        title: `Auto-Claimed Pro-Rata Closure Surplus`,
        rationale: `Pool is in closing state. Autonomous delegation claimed member pro-rata surplus share directly to connected wallet.`,
        confidenceScore: 99,
        status: 'executed',
        poolId: pool.id,
        poolAddress: pool.address,
      })
    } else {
      decisions.push({
        id: `audit-closure-refund-${pool.id}-${nowSeconds}`,
        timestamp: nowSeconds * 1000,
        tier: config.tier,
        actionType: 'claim_refund',
        title: `Closure Surplus Refund Available`,
        rationale: `Pool closure detected with pro-rata surplus claimable. Recommended action: invoke claim_closure_refund.`,
        confidenceScore: 96,
        status: 'recommended',
        poolId: pool.id,
        poolAddress: pool.address,
      })
    }
  }

  return decisions
}

/**
 * Natural language conversational processor for pool governance, quorum queries,
 * proposals, and autonomous operations.
 */
export function processCopilotQuery(
  rawQuery: string,
  pool?: CopilotPoolSnapshot | null,
  config: CopilotConfig = DEFAULT_COPILOT_CONFIG
): CopilotMessage {
  if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
    throw new Error('Missing or empty query string provided to processCopilotQuery.')
  }
  validateCopilotConfig(config)

  const query = rawQuery.trim().toLowerCase()
  const now = Date.now()

  // 1. Quorum queries
  if (query.includes('quorum') || query.includes('participation') || query.includes('locked')) {
    if (!pool) {
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 90,
        text: 'No pool is currently selected. Connect your wallet and select a pool to inspect quorum status.',
      }
    }

    const isLocked = Boolean(pool.isLocked)
    const threshold = pool.voteThreshold ?? 3
    const members = pool.memberCount
    const cap = pool.memberCap

    let messageText = `Pool "${pool.name}" has ${members} of ${cap} active members. Required vote threshold: ${threshold} members.`
    if (isLocked) {
      messageText += ` ⚠️ Quorum warning: The pool is currently locked due to consecutive missed quorums. Autonomous voting is paused until participation resumes.`
    } else {
      messageText += ` Quorum health is nominal. Current voting tier: ${config.tier.toUpperCase()}.`
    }

    return {
      id: `msg-${now}`,
      sender: 'assistant',
      timestamp: now,
      confidenceScore: 96,
      text: messageText,
      metrics: {
        memberCount: members,
        memberCap: cap,
        voteThreshold: threshold,
        isLocked,
      },
    }
  }

  // 2. Pending Proposals queries
  if (query.includes('proposal') || query.includes('pending') || query.includes('vote')) {
    if (!pool || !pool.proposals || pool.proposals.length === 0) {
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 94,
        text: `There are currently no active or pending proposals for pool "${pool?.name ?? 'selected pool'}". All cycle governance items are up to date.`,
      }
    }

    const openProps = pool.proposals.filter(p => p.state === 'Open')
    const execProps = pool.proposals.filter(p => p.state === 'Executable' || (p.isPassed && p.state === 'Open'))

    let text = `Found ${pool.proposals.length} proposal(s): ${openProps.length} open for voting, ${execProps.length} ready for execution.`
    if (execProps.length > 0) {
      const top = execProps[0]
      text += `\n• Proposal #${top.id} (${top.actionType}) has satisfied voting requirements (${top.yesVotes}/${top.voteThreshold}) and can be executed.`
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 97,
        text,
        actionSuggestion: {
          label: `Execute Proposal #${top.id}`,
          actionType: 'execute_proposal',
          proposalId: top.id,
        },
      }
    }

    return {
      id: `msg-${now}`,
      sender: 'assistant',
      timestamp: now,
      confidenceScore: 95,
      text,
    }
  }

  // 3. Execution queries ("Execute passed proposals")
  if (query.includes('execute') || query.includes('crank') || query.includes('run')) {
    if (!pool || !pool.proposals || pool.proposals.length === 0) {
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 92,
        text: 'No executable proposals found to execute.',
      }
    }

    const execProps = pool.proposals.filter(p => p.state === 'Executable' || (p.isPassed && p.state === 'Open'))
    if (execProps.length === 0) {
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 95,
        text: 'All proposals have either been executed or are still gathering quorum votes. No action required.',
      }
    }

    const target = execProps[0]
    return {
      id: `msg-${now}`,
      sender: 'assistant',
      timestamp: now,
      confidenceScore: 98,
      text: `Proposal #${target.id} (${target.actionType}) is eligible for execution with ${target.yesVotes} votes (threshold: ${target.voteThreshold}). Dispatched execution instruction.`,
      actionSuggestion: {
        label: `Execute Proposal #${target.id}`,
        actionType: 'execute_proposal',
        proposalId: target.id,
      },
    }
  }

  // 4. Cycle status / deadline queries
  if (query.includes('cycle') || query.includes('deadline') || query.includes('overdue')) {
    if (!pool) {
      return {
        id: `msg-${now}`,
        sender: 'assistant',
        timestamp: now,
        confidenceScore: 90,
        text: 'Select a pool to inspect cycle duration and rollover timing.',
      }
    }

    const currentCycle = pool.currentCycle
    const started = pool.cycleStartedAt ?? 0
    const duration = pool.cycleDurationSeconds ?? 0
    const deadline = started + duration
    const nowSec = Math.floor(now / 1000)
    const isOverdue = duration > 0 && nowSec >= deadline

    let text = `Pool "${pool.name}" is on Cycle #${currentCycle}.`
    if (duration > 0) {
      if (isOverdue) {
        const mins = Math.floor((nowSec - deadline) / 60)
        text += ` ⚠️ This cycle is ${mins} minute(s) overdue. ${config.toggles.autoRollCycle ? 'Autonomous auto-roll is primed to crank the renewal.' : 'Recommend executing a cycle advance.'}`
        return {
          id: `msg-${now}`,
          sender: 'assistant',
          timestamp: now,
          confidenceScore: 96,
          text,
          actionSuggestion: {
            label: `Roll Cycle #${currentCycle + 1}`,
            actionType: 'roll_cycle',
          },
        }
      } else {
        const remaining = Math.max(0, Math.floor((deadline - nowSec) / 60))
        text += ` Next cycle renewal in approximately ${remaining} minute(s).`
      }
    }

    return {
      id: `msg-${now}`,
      sender: 'assistant',
      timestamp: now,
      confidenceScore: 94,
      text,
    }
  }

  // 5. Autonomy tier and settings queries
  if (query.includes('tier') || query.includes('autonomy') || query.includes('setting') || query.includes('risk')) {
    const tierLabels = {
      advisory: 'Tier 1: Advisory Mode (Low Risk / Zero Autonomy)',
      supervised: 'Tier 2: Supervised Automation (Medium Risk / Semi-Autonomous)',
      autonomous: 'Tier 3: Autonomous Delegation (High Risk / Full Autonomy)',
    }
    const text = `Current Copilot Mode: ${tierLabels[config.tier]}.\n• Auto-roll cycle: ${config.toggles.autoRollCycle ? 'ON' : 'OFF'}\n• Auto-execute proposals: ${config.toggles.autoExecutePassedProposals ? 'ON' : 'OFF'}\n• Lineage auto-vote: ${config.toggles.autoVoteLineageYes ? 'ON' : 'OFF'}\n• Candidate auto-vouch: ${config.toggles.autoVouchCandidates ? 'ON' : 'OFF'}\n• Auto-claim closure refund: ${config.toggles.autoClaimSurplusRefund ? 'ON' : 'OFF'}`

    return {
      id: `msg-${now}`,
      sender: 'assistant',
      timestamp: now,
      confidenceScore: 99,
      text,
    }
  }

  // 6. General capabilities / Help
  return {
    id: `msg-${now}`,
    sender: 'assistant',
    timestamp: now,
    confidenceScore: 92,
    text: `I am your ComFi Copilot, delegated to manage and monitor pool governance. Try asking:\n• "What is our quorum status?"\n• "Are there pending proposals to vote on?"\n• "Execute passed proposals"\n• "What is our cycle deadline?"\n• "What is my current autonomy tier?"`,
  }
}
