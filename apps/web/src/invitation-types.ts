export type AdmissionMode = 'InviteVouched' | 'Open'

export interface CreatePoolModalParams {
  name: string
  admissionMode: AdmissionMode
  memberObligationAmount: number // in USDC
  minimumDeposit: number // in USDC
  cycleDurationDays: number // in days
  memberCap: number
  voteThresholdBps: number // basis points, e.g. 5001 = 50.01%
  minQuorumMembers: number
  autoCloseCyclesThreshold: number
  executionMode: 'on_deadline' | 'threshold_met'
}

export type InvitationStatus =
  | 'pending_submission'     // Link created, waiting for invitee wallet
  | 'wallet_submitted'        // Invitee submitted wallet, webhook detected
  | 'proposal_queued'         // AdmitMember proposal dispatched on behalf of inviter
  | 'proposal_voting'         // Proposal actively being voted on
  | 'proposal_executable'     // Proposal reached threshold/passed, ready for execution
  | 'admitted'                // Member admission executed on-chain
  | 'revoked'                 // Inviter canceled invite
  | 'expired'                 // Expired after deadline

export interface InvitationPayload {
  inviteId: string
  poolAddress: string
  poolName: string
  inviterAddress: string
  inviterName?: string
  admissionMode: AdmissionMode
  memberObligationAmount?: string
  cycleDurationDays?: number
  createdAt: string
  expiresAt: string
  note?: string
}

export interface InvitationRecord extends InvitationPayload {
  candidateWallet?: string
  candidateName?: string
  status: InvitationStatus
  submittedAt?: string
  proposalId?: number
  proposalAddress?: string
  executedAt?: string
  shareUrl: string
  emailMessage: string
  webhookDispatchedAt?: string
  webhookAuditId?: string
}

export interface InvitationWebhookEvent {
  type: 'INVITE_WALLET_SUBMITTED'
  inviteId: string
  poolAddress: string
  candidateWallet: string
  candidateName?: string
  inviterAddress: string
  submittedAt: string
}

export interface AdmitMemberProposalDispatchResult {
  success: boolean
  proposalId: number
  proposalAddress: string
  poolAddress: string
  candidateWallet: string
  vouchedBy: string
  actionType: 'AdmitMember'
  dispatchedAt: string
}
