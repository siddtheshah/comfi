import { FC, useEffect, useState } from 'react'
import type { InvitationRecord } from './invitation-types'
import {
  executeAdmission,
  getInvitationsForPool,
  onInvitationsChange,
  onInvitationWebhook,
  revokeInvitation,
} from './invitation-engine'

interface InviteTrackingCardProps {
  poolAddress: string
  poolName: string
  inviterAddress?: string
  onOpenInviteModal: () => void
  onOpenAcceptModal?: (token: string) => void
  onAdmissionExecuted?: (record: InvitationRecord) => void
}

export const InviteTrackingCard: FC<InviteTrackingCardProps> = ({
  poolAddress,
  poolName,
  inviterAddress,
  onOpenInviteModal,
  onOpenAcceptModal,
  onAdmissionExecuted,
}) => {
  const [invitations, setInvitations] = useState<InvitationRecord[]>(() => {
    return poolAddress ? getInvitationsForPool(poolAddress) : []
  })
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [executingId, setExecutingId] = useState<string | null>(null)

  const refreshList = () => {
    if (poolAddress) {
      setInvitations(getInvitationsForPool(poolAddress))
    }
  }

  useEffect(() => {
    refreshList()
    const unsubChange = onInvitationsChange(refreshList)
    const unsubWebhook = onInvitationWebhook(refreshList)
    return () => {
      unsubChange()
      unsubWebhook()
    }
  }, [poolAddress])

  const handleCopyLink = async (url: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(url)
      setActionNotice('Invitation link copied to clipboard!')
      setTimeout(() => setActionNotice(null), 3000)
    }
  }

  const handleExecuteAdmission = async (inviteId: string) => {
    setExecutingId(inviteId)
    const updated = await executeAdmission(inviteId)
    setExecutingId(null)
    setActionNotice(`Member ${updated.candidateWallet?.slice(0, 4)}…${updated.candidateWallet?.slice(-4)} admitted successfully!`)
    refreshList()
    if (onAdmissionExecuted) {
      onAdmissionExecuted(updated)
    }
    setTimeout(() => setActionNotice(null), 4000)
  }

  const handleRevoke = (inviteId: string) => {
    revokeInvitation(inviteId)
    setActionNotice('Invitation revoked.')
    refreshList()
    setTimeout(() => setActionNotice(null), 3000)
  }

  // Calculate summary counts
  const pendingSubmissionCount = invitations.filter(i => i.status === 'pending_submission').length
  const awaitingGovernanceCount = invitations.filter(
    i => i.status === 'proposal_queued' || i.status === 'proposal_voting' || i.status === 'wallet_submitted'
  ).length
  const admittedCount = invitations.filter(i => i.status === 'admitted').length

  const getStatusBadge = (status: InvitationRecord['status'], proposalId?: number) => {
    switch (status) {
      case 'pending_submission':
        return <span className="status-badge pending">Pending Recipient</span>
      case 'wallet_submitted':
        return <span className="status-badge submitted">Wallet Submitted</span>
      case 'proposal_queued':
        return <span className="status-badge queued">Proposal #{proposalId} Queued</span>
      case 'proposal_voting':
        return <span className="status-badge voting">Voting Active</span>
      case 'proposal_executable':
        return <span className="status-badge executable">Ready to Admit</span>
      case 'admitted':
        return <span className="status-badge admitted">Admitted ✓</span>
      case 'revoked':
        return <span className="status-badge revoked">Revoked</span>
      case 'expired':
        return <span className="status-badge expired">Expired</span>
      default:
        return <span className="status-badge">{status}</span>
    }
  }

  return (
    <div className="invite-tracking-card" data-testid="invite-tracking-card">
      <div className="tracking-header">
        <div>
          <div className="badge-row">
            <span className="eyebrow">ONBOARDING PIPELINE</span>
            <span className="webhook-indicator">⚡ Automated Webhook Active</span>
          </div>
          <h3>Member Invitations & Admission Tracking</h3>
          <p>
            Track prospective members, automated AdmitMember governance proposals, and admission execution.
          </p>
        </div>
        <button
          type="button"
          className="primary-small"
          data-testid="open-invite-modal-btn"
          onClick={onOpenInviteModal}
        >
          ＋ Invite Member
        </button>
      </div>

      {actionNotice && (
        <div className="wallet-alert success" role="status">
          <span>{actionNotice}</span>
          <button onClick={() => setActionNotice(null)}>✕</button>
        </div>
      )}

      <div className="tracking-stats-grid">
        <div className="stat-card">
          <small>Total Invites</small>
          <strong>{invitations.length}</strong>
        </div>
        <div className="stat-card">
          <small>Pending Wallet</small>
          <strong className="text-pending">{pendingSubmissionCount}</strong>
        </div>
        <div className="stat-card">
          <small>Awaiting Governance</small>
          <strong className="text-queued">{awaitingGovernanceCount}</strong>
        </div>
        <div className="stat-card">
          <small>Admitted Members</small>
          <strong className="text-admitted">{admittedCount}</strong>
        </div>
      </div>

      <div className="invitations-table-wrapper">
        {invitations.length === 0 ? (
          <div className="empty-invitations" data-testid="empty-invitations">
            <p>No active member invitations for this pool yet.</p>
            <button
              type="button"
              className="outline-small"
              onClick={onOpenInviteModal}
            >
              Send First Invitation
            </button>
          </div>
        ) : (
          <div className="invitations-list">
            {invitations.map(inv => (
              <div key={inv.inviteId} className="invitation-item-card" data-testid={`invite-item-${inv.inviteId}`}>
                <div className="invite-item-main">
                  <div className="invite-item-head">
                    <strong>{inv.candidateName ?? (inv.candidateWallet ? `${inv.candidateWallet.slice(0, 6)}…${inv.candidateWallet.slice(-6)}` : 'Prospective Member')}</strong>
                    {getStatusBadge(inv.status, inv.proposalId)}
                  </div>

                  <div className="invite-meta-row">
                    <span>
                      Vouched by: <code title={inv.inviterAddress}>{inv.inviterName ?? `${inv.inviterAddress.slice(0, 4)}…${inv.inviterAddress.slice(-4)}`}</code>
                    </span>
                    <span>Created: {new Date(inv.createdAt).toLocaleDateString()}</span>
                    {inv.candidateWallet && (
                      <span className="candidate-addr">
                        Wallet: <code title={inv.candidateWallet}>{inv.candidateWallet.slice(0, 4)}…{inv.candidateWallet.slice(-4)}</code>
                      </span>
                    )}
                  </div>

                  {inv.webhookDispatchedAt && (
                    <div className="webhook-dispatch-note">
                      ⚡ Webhook dispatched <code>AdmitMember</code> proposal #{inv.proposalId} at {new Date(inv.webhookDispatchedAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>

                <div className="invite-item-actions">
                  {inv.status === 'pending_submission' && (
                    <>
                      <button
                        type="button"
                        className="btn-tiny"
                        data-testid="tracking-copy-link"
                        onClick={() => handleCopyLink(inv.shareUrl)}
                        title="Copy Invitation Link"
                      >
                        Copy Link
                      </button>

                      {onOpenAcceptModal && (
                        <button
                          type="button"
                          className="btn-tiny btn-action"
                          data-testid="simulate-accept-btn"
                          onClick={() => {
                            const match = inv.shareUrl.match(/invite=([^&]+)/)
                            if (match && match[1]) {
                              onOpenAcceptModal(decodeURIComponent(match[1]))
                            }
                          }}
                          title="Simulate Recipient Wallet Submission"
                        >
                          Simulate Accept
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn-tiny btn-danger-tiny"
                        data-testid="revoke-invite-btn"
                        onClick={() => handleRevoke(inv.inviteId)}
                      >
                        Revoke
                      </button>
                    </>
                  )}

                  {(inv.status === 'proposal_queued' || inv.status === 'proposal_voting' || inv.status === 'proposal_executable') && (
                    <button
                      type="button"
                      className="btn-tiny btn-execute"
                      data-testid="execute-admit-btn"
                      disabled={executingId === inv.inviteId}
                      onClick={() => handleExecuteAdmission(inv.inviteId)}
                    >
                      {executingId === inv.inviteId ? 'Admitting…' : 'Execute Admission ✓'}
                    </button>
                  )}

                  {inv.status === 'admitted' && (
                    <span className="admitted-check-tag">✓ Admitted</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
