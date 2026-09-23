export interface WalletInfo {
  name: 'administrator' | 'creator' | 'member2' | 'quote-authority'
  label: string
  publicKey: string
  solBalance: string
  usdcAta: string
  usdcBalance: string
}

export interface GlobalConfigInfo {
  initialized: boolean
  address: string
  usdcMint: string
  treasuryUsdc: string
  quoteAuthority: string
  nextPoolId: number
  pausedNewPools: boolean
}

export interface PoolInfo {
  address: string
  id: number
  creator: string
  vault: string
  vaultUsdcBalance: string
  memberCap: number
  memberCount: number
  minimumDeposit: string
  memberObligationAmount: string
  voteThreshold: number
  votingPeriodSeconds: number
  timelockSeconds: number
  currentCycle: number
  cycleDurationSeconds: number
  cycleStartedAt: number
  actionAllowancePerCycle: string
  maxSponsoredActionCharge: string
  nextRequestId: number
  nextProposalId: number
  testingEnabled: boolean
  hasPendingConfig: boolean
  pendingVoteThreshold: number
  pendingCycleDurationSeconds: number
  pendingMemberObligationAmount: string
  spenderLimitDeadlineCycles: number
  withdrawalDeadlineCycles: number
  configModificationDeadlineCycles: number
  pendingSpenderLimitDeadlineCycles: number
  pendingWithdrawalDeadlineCycles: number
  pendingConfigModificationDeadlineCycles: number
  spenderLimitExecutionMode: ExecutionMode
  withdrawalExecutionMode: ExecutionMode
  configModificationExecutionMode: ExecutionMode
  pendingSpenderLimitExecutionMode: ExecutionMode
  pendingWithdrawalExecutionMode: ExecutionMode
  pendingConfigModificationExecutionMode: ExecutionMode
}

export type ExecutionMode = 'on_deadline' | 'threshold_met'

export interface MemberInfo {
  address: string
  pool: string
  wallet: string
  role: 'Admin' | 'Spender' | 'Member'
  isFunded: boolean
  depositedTotal: string
  aliasHashHex: string
  encryptionPubKeyHex: string
  aliasVersion: number
  allowanceCycle: number
  actionAllowanceUsed: string
  spendLimit?: string
  spentCurrentCycle?: string
}

export interface ProposalInfo {
  address: string
  pool: string
  id: number
  proposer: string
  actionType: 'SetSpenderLimit' | 'ApproveWithdrawal' | 'ConfigurationModification' | 'Other'
  actionDetails: string
  yesVotes: number
  noVotes: number
  votingCycle: number
  deadlineCycle: number
  deadline: number
  executableAfter: number
  state: 'Queued' | 'Open' | 'Executable' | 'Executed' | 'Rejected'
  executionMode: ExecutionMode
  voteThreshold: number
}

export interface WithdrawalRequestInfo {
  address: string
  pool: string
  id: number
  requester: string
  recipient: string
  amount: string
  justificationHashHex: string
  requiresProposal: boolean
  status: 'Pending' | 'Spent' | 'Cancelled'
}

export interface SponsorQuoteResult {
  quoteId: string
  pool: string
  member: string
  action: string
  chargeUsdc: string
  expiresAt: string
  signature: string
  verified: boolean
}

export interface SystemStatus {
  connected: boolean
  rpcUrl: string
  programId: string
  slot: number
  global: GlobalConfigInfo
  wallets: Record<string, WalletInfo>
  pools: PoolInfo[]
}

export interface DevLogEntry {
  id: string
  time: string
  type: 'info' | 'success' | 'error'
  title: string
  details?: string
}
