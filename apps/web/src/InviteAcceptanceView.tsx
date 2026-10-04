import { FC, FormEvent, useEffect, useState } from 'react'
import type { AdmitMemberProposalDispatchResult, InvitationPayload, InvitationRecord } from './invitation-types'
import { decodeInvitationPayload, submitRecipientWallet, validateSolanaAddress } from './invitation-engine'

interface InviteAcceptanceViewProps {
  isOpen: boolean
  onClose: () => void
  token?: string
  connectedWalletAddress?: string
  onAccepted?: (record: InvitationRecord, result: AdmitMemberProposalDispatchResult) => void
}

export const InviteAcceptanceView: FC<InviteAcceptanceViewProps> = ({
  isOpen,
  onClose,
  token,
  connectedWalletAddress,
  onAccepted,
}) => {
  const [tokenInput, setTokenInput] = useState(token ?? '')
  const [decodedPayload, setDecodedPayload] = useState<InvitationPayload | null>(null)
  const [decodeError, setDecodeError] = useState<string | null>(null)

  const [walletAddress, setWalletAddress] = useState('')
  const [candidateName, setCandidateName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<{
    record: InvitationRecord
    result: AdmitMemberProposalDispatchResult
  } | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Auto-decode when token changes
  useEffect(() => {
    if (token) {
      setTokenInput(token)
      tryDecode(token)
    }
  }, [token])

  // Pre-fill wallet if user connects one
  useEffect(() => {
    if (connectedWalletAddress && !walletAddress) {
      setWalletAddress(connectedWalletAddress)
    }
  }, [connectedWalletAddress])

  if (!isOpen) return null

  function tryDecode(tokenToDecode: string) {
    setDecodeError(null)
    setDecodedPayload(null)
    if (!tokenToDecode.trim()) return

    // Decode without evading errors
    const payload = decodeInvitationPayload(tokenToDecode.trim())
    setDecodedPayload(payload)
  }

  const handleManualDecode = (e: FormEvent) => {
    e.preventDefault()
    setDecodeError(null)
    if (!tokenInput.trim()) {
      setDecodeError('Please enter a valid invitation link or token.')
      return
    }
    // Extract token if user pasted the full URL
    let cleanToken = tokenInput.trim()
    if (cleanToken.includes('invite=')) {
      const match = cleanToken.match(/invite=([^&]+)/)
      if (match && match[1]) {
        cleanToken = decodeURIComponent(match[1])
      }
    }
    tryDecode(cleanToken)
  }

  const handleAcceptSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    if (!decodedPayload) {
      setSubmitError('No valid invitation is currently loaded.')
      return
    }

    if (!walletAddress.trim()) {
      setSubmitError('Solana wallet address is required.')
      return
    }

    // Validate format
    validateSolanaAddress(walletAddress.trim(), 'candidateWallet')

    setSubmitting(true)
    const { record, webhookResult } = await submitRecipientWallet(
      decodedPayload.inviteId,
      walletAddress.trim(),
      candidateName.trim() || undefined
    )

    setSubmitting(false)
    setSubmissionResult({ record, result: webhookResult })
    if (onAccepted) {
      onAccepted(record, webhookResult)
    }
  }

  const handleClose = () => {
    setSubmissionResult(null)
    setSubmitError(null)
    setDecodeError(null)
    onClose()
  }

  return (
    <div className="wallet-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="invite-accept-title">
      <div className="invite-accept-modal-card" data-testid="invite-accept-modal">
        <div className="wallet-modal-header">
          <div>
            <div className="wallet-modal-badge">
              <span className="network-dot" />
              <span>Pool Membership Invitation</span>
            </div>
            <h2 id="invite-accept-title">Join Community Pool</h2>
          </div>
          <button
            className="wallet-modal-close"
            onClick={handleClose}
            aria-label="Close modal"
            data-testid="invite-accept-close"
          >
            ✕
          </button>
        </div>

        {decodeError && (
          <div className="wallet-alert error" role="alert">
            <span>{decodeError}</span>
            <button onClick={() => setDecodeError(null)}>✕</button>
          </div>
        )}

        {submitError && (
          <div className="wallet-alert error" role="alert">
            <span>{submitError}</span>
            <button onClick={() => setSubmitError(null)}>✕</button>
          </div>
        )}

        {!submissionResult ? (
          <div>
            {!decodedPayload ? (
              <form onSubmit={handleManualDecode} className="decode-form">
                <p className="field-hint">
                  Paste the invitation link or encrypted token you received from a pool member:
                </p>
                <label className="field-label">
                  Invitation Link or Token
                  <textarea
                    className="textarea-input text-mono"
                    data-testid="manual-token-input"
                    rows={4}
                    placeholder="e.g. http://localhost:5173/?invite=... or eyJpbnZpdGVJZ..."
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                    required
                  />
                </label>
                <div className="modal-actions-footer">
                  <button type="button" className="ghost" onClick={handleClose}>
                    Cancel
                  </button>
                  <button type="submit" className="primary" data-testid="load-invite-btn">
                    Verify Invitation <span>→</span>
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleAcceptSubmit} className="accept-form">
                <div className="invite-hero-banner">
                  <span className="invite-hero-icon">📬</span>
                  <div>
                    <h3>You are invited to join {decodedPayload.poolName}</h3>
                    <p>
                      Vouched by <b>{decodedPayload.inviterName ?? `${decodedPayload.inviterAddress.slice(0, 6)}…${decodedPayload.inviterAddress.slice(-6)}`}</b>
                    </p>
                  </div>
                </div>

                <div className="invite-details-card">
                  <div className="detail-item">
                    <small>Pool Address</small>
                    <code className="pda-code" title={decodedPayload.poolAddress}>
                      {decodedPayload.poolAddress.slice(0, 8)}…{decodedPayload.poolAddress.slice(-8)}
                    </code>
                  </div>
                  <div className="detail-item">
                    <small>Admission Mode</small>
                    <span className="tag onchain">
                      {decodedPayload.admissionMode === 'InviteVouched' ? 'Invite & Vouched' : 'Open'}
                    </span>
                  </div>
                  {decodedPayload.memberObligationAmount && (
                    <div className="detail-item">
                      <small>Member Obligation</small>
                      <strong>{decodedPayload.memberObligationAmount} / cycle</strong>
                    </div>
                  )}
                  {decodedPayload.cycleDurationDays && (
                    <div className="detail-item">
                      <small>Cycle Duration</small>
                      <strong>{decodedPayload.cycleDurationDays} days</strong>
                    </div>
                  )}
                  {decodedPayload.note && (
                    <div className="detail-item full-width">
                      <small>Message from Inviter</small>
                      <p className="invite-note-text">"{decodedPayload.note}"</p>
                    </div>
                  )}
                </div>

                <div className="wallet-input-section">
                  <span className="section-label">Your Solana Candidate Wallet</span>
                  <p className="field-hint">
                    Connect or enter your Solana wallet to be admitted to this pool:
                  </p>

                  {connectedWalletAddress && (
                    <div className="connected-wallet-pill">
                      <span>Connected Wallet: <b>{connectedWalletAddress.slice(0, 6)}…{connectedWalletAddress.slice(-6)}</b></span>
                      <button
                        type="button"
                        className="use-wallet-btn"
                        data-testid="use-connected-wallet-btn"
                        onClick={() => setWalletAddress(connectedWalletAddress)}
                      >
                        Use This Wallet
                      </button>
                    </div>
                  )}

                  <label className="field-label">
                    Solana Public Key (Address)
                    <input
                      type="text"
                      className="text-input text-mono"
                      data-testid="recipient-wallet-input"
                      placeholder="e.g. 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
                      value={walletAddress}
                      onChange={e => setWalletAddress(e.target.value)}
                      required
                    />
                  </label>

                  <label className="field-label">
                    Your Name or Alias (Optional)
                    <input
                      type="text"
                      className="text-input"
                      data-testid="recipient-name-input"
                      placeholder="e.g. Maya S."
                      value={candidateName}
                      onChange={e => setCandidateName(e.target.value)}
                    />
                  </label>
                </div>

                <div className="webhook-pipeline-explainer">
                  <span className="webhook-badge">⚡ Automated Webhook Pipeline</span>
                  <p>
                    Submitting your address triggers our automated onboarding pipeline, immediately dispatching an <code>AdmitMember</code> governance proposal vouched by your inviter.
                  </p>
                </div>

                <div className="modal-actions-footer">
                  <button type="button" className="ghost" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary"
                    data-testid="accept-invite-submit"
                    disabled={submitting}
                  >
                    {submitting ? 'Submitting & Dispatching…' : <>Accept & Submit Wallet <span>→</span></>}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="submission-success-view" data-testid="submission-success-card">
            <div className="result-header">
              <span className="result-check">✓</span>
              <div>
                <h3>Wallet Submitted & Proposal Dispatched!</h3>
                <p>The automated onboarding pipeline has registered your candidate address.</p>
              </div>
            </div>

            <div className="proposal-dispatched-card">
              <div className="pipeline-step completed">
                <span className="step-num">1</span>
                <div>
                  <strong>Recipient Wallet Submitted</strong>
                  <p className="text-mono">{submissionResult.record.candidateWallet}</p>
                </div>
              </div>

              <div className="pipeline-step completed">
                <span className="step-num">2</span>
                <div>
                  <strong>Automated Webhook Triggered</strong>
                  <p>Webhook listener detected wallet submission from invite #{submissionResult.record.inviteId.slice(-6)}.</p>
                </div>
              </div>

              <div className="pipeline-step active">
                <span className="step-num">3</span>
                <div>
                  <strong>AdmitMember Governance Proposal Dispatched</strong>
                  <p>
                    Proposal <b>#{submissionResult.result.proposalId}</b> created on pool <code>{submissionResult.record.poolAddress.slice(0, 6)}…{submissionResult.record.poolAddress.slice(-6)}</code> vouched by <code>{submissionResult.record.inviterAddress.slice(0, 6)}…{submissionResult.record.inviterAddress.slice(-6)}</code>.
                  </p>
                </div>
              </div>

              <div className="pipeline-step">
                <span className="step-num">4</span>
                <div>
                  <strong>Governance Approval & Admission</strong>
                  <p>Once quorum votes or timelock completes, your membership will be executed on-chain.</p>
                </div>
              </div>
            </div>

            <div className="modal-actions-footer">
              <button
                type="button"
                className="primary"
                onClick={handleClose}
                data-testid="close-success-btn"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
