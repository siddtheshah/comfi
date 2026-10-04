import type { OnChainPool } from './solana'

export type PoolItem = {
  chain: OnChainPool
  id: string
  icon: string
  name: string
  role: string
  status: string
  balance: string
  funds: string
  nextDate: string
  proposals: number
  requests: number
  cap: number
  slots: number
  accent: string
  address?: string
  vault?: string
  creator?: string
  onChain?: boolean
  minimumDeposit?: string
  voteThreshold?: number
  votingPeriodSeconds?: number
  timelockSeconds?: number
  currentCycle?: number
  cycleStartedAt?: number
  admissionMode?: 'InviteVouched' | 'Open'
  memberObligationAmount?: string
  cycleDurationSeconds?: number
}
