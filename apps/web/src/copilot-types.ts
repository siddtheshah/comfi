export type AutonomyTier = 'advisory' | 'supervised' | 'autonomous'

export interface CapabilityToggles {
  autoRollCycle: boolean
  autoExecutePassedProposals: boolean
  autoVouchCandidates: boolean
  autoVoteLineageYes: boolean
  autoClaimSurplusRefund: boolean
}

export type ActionStatus = 'executed' | 'recommended' | 'pending_approval' | 'blocked'

export interface DecisionAuditEntry {
  id: string
  timestamp: number
  tier: AutonomyTier
  actionType:
    | 'roll_cycle'
    | 'execute_proposal'
    | 'vote_proposal'
    | 'vouch_candidate'
    | 'claim_refund'
    | 'quorum_alert'
    | 'query_response'
  title: string
  rationale: string
  confidenceScore: number // 0 - 100
  status: ActionStatus
  poolAddress?: string
  poolId?: string
  proposalId?: number
  details?: Record<string, unknown>
}

export interface CopilotMessage {
  id: string
  sender: 'user' | 'assistant'
  text: string
  timestamp: number
  confidenceScore?: number
  actionSuggestion?: {
    label: string
    actionType: DecisionAuditEntry['actionType']
    proposalId?: number
  }
  metrics?: Record<string, string | number | boolean>
}

export interface CopilotConfig {
  tier: AutonomyTier
  toggles: CapabilityToggles
  autoCrankEnabled: boolean
  lastEvaluatedAt?: number
}

export interface CopilotPoolSnapshot {
  id: string
  name: string
  address?: string
  balance?: string
  memberCount: number
  memberCap: number
  currentCycle: number
  cycleStartedAt?: number
  cycleDurationSeconds?: number
  isLocked?: boolean
  isClosing?: boolean
  voteThreshold?: number
  votingPeriodSeconds?: number
  proposals?: CopilotProposalSnapshot[]
  members?: CopilotMemberSnapshot[]
  totalSurplus?: string
  hasPendingRefund?: boolean
}

export interface CopilotProposalSnapshot {
  id: number
  actionType: string
  actionDetails?: string
  state: 'Queued' | 'Open' | 'Executable' | 'Executed' | 'Rejected'
  yesVotes: number
  noVotes: number
  voteThreshold: number
  deadline?: number
  isPassed: boolean
  isExecutable: boolean
  isRoutine: boolean
  targetMember?: string
  candidateWallet?: string
  vouchedBy?: string
  amount?: string
}

export interface CopilotMemberSnapshot {
  wallet: string
  status: 'Active' | 'Leaving' | 'Exited' | 'Evicted'
  isFunded: boolean
  isMaturedVoter: boolean
  lineageDepth: number
  vouchedBy?: string | null
  streak?: number
  claimableSurplus?: string
}
