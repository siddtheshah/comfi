import { FC, FormEvent, useState } from 'react'
import type { AdmissionMode, InvitationRecord } from './invitation-types'
import { createInvitation } from './invitation-engine'

interface InviteMembersModalProps {
  isOpen: boolean
  onClose: () => void
  poolAddress: string
  poolName: string
  inviterAddress: string
  inviterName?: string
  admissionMode?: AdmissionMode
  memberObligationAmount?: string
  cycleDurationDays?: number
  onInviteCreated?: (invite: InvitationRecord) => void
}

export const InviteMembersModal: FC<InviteMembersModalProps> = ({
  isOpen,
  onClose,
  poolAddress,
  poolName,
  inviterAddress,
  inviterName,
  admissionMode = 'InviteVouched',
  memberObligationAmount,
  cycleDurationDays,
  onInviteCreated,
}) => {
  const [inviteeName, setInviteeName] = useState('')
  const [note, setNote] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [createdInvite, setCreatedInvite] = useState<InvitationRecord | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setCopyNotice(null)

    if (!poolAddress || !inviterAddress) {
      setError('Cannot create invitation: missing pool or inviter wallet address.')
      return
    }

    const invite = createInvitation({
      poolAddress,
      poolName,
      inviterAddress,
      inviterName: inviterName || undefined,
      candidateName: inviteeName.trim() || undefined,
      admissionMode,
      expiresInDays,
      note: note.trim() || undefined,
      memberObligationAmount,
      cycleDurationDays,
    })

    setCreatedInvite(invite)
    if (onInviteCreated) {
      onInviteCreated(invite)
    }
  }

  const copyToClipboard = async (text: string, label: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      setCopyNotice(`Copied ${label} to clipboard!`)
      setTimeout(() => setCopyNotice(null), 3000)
    }
  }

  const resetModal = () => {
    setCreatedInvite(null)
    setInviteeName('')
    setNote('')
    setCopyNotice(null)
    setError(null)
  }

  const handleClose = () => {
    resetModal()
    onClose()
  }

  return (
    <div className="wallet-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
      <div className="invite-modal-card" data-testid="invite-modal">
        <div className="wallet-modal-header">
          <div>
            <div className="wallet-modal-badge">
              <span className="network-dot" />
              <span>Member Onboarding</span>
            </div>
            <h2 id="invite-modal-title">Invite New Member</h2>
          </div>
          <button
            className="wallet-modal-close"
            onClick={handleClose}
            aria-label="Close modal"
            data-testid="invite-modal-close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="wallet-alert error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {copyNotice && (
          <div className="wallet-alert success" role="status">
            <span>{copyNotice}</span>
          </div>
        )}

        {!createdInvite ? (
          <form onSubmit={handleCreate} className="create-invite-form">
            <div className="pool-invite-context">
              <div className="context-item">
                <small>Pool</small>
                <strong>{poolName}</strong>
              </div>
              <div className="context-item">
                <small>Admission Mode</small>
                <span className="tag onchain">
                  {admissionMode === 'InviteVouched' ? 'Invite & Vouched' : 'Open'}
                </span>
              </div>
              <div className="context-item">
                <small>Invited By</small>
                <strong>{inviterName ?? `${inviterAddress.slice(0, 4)}…${inviterAddress.slice(-4)}`}</strong>
              </div>
            </div>

            <label className="field-label">
              Prospective Member Name / Handle (Optional)
              <input
                type="text"
                className="text-input"
                data-testid="invitee-name-field"
                placeholder="e.g. Maya S., Alice"
                value={inviteeName}
                onChange={e => setInviteeName(e.target.value)}
              />
            </label>

            <label className="field-label">
              Invitation Expiry
              <select
                className="select-input"
                data-testid="invitee-expiry-select"
                value={expiresInDays}
                onChange={e => setExpiresInDays(parseInt(e.target.value, 10))}
              >
                <option value={3}>3 Days</option>
                <option value={7}>7 Days (Standard)</option>
                <option value={14}>14 Days</option>
                <option value={30}>30 Days</option>
              </select>
            </label>

            <label className="field-label">
              Personal Note / Welcome Message (Optional)
              <textarea
                className="textarea-input"
                data-testid="invitee-note-field"
                rows={3}
                placeholder="Add a welcoming note or context for the invited candidate."
                value={note}
                onChange={e => setNote(e.target.value)}
              />
            </label>

            <div className="form-info-box">
              <p>
                ℹ️ When the candidate accepts this invite and connects or submits their Solana wallet address, our automated onboarding pipeline will immediately dispatch an <code>AdmitMember</code> governance proposal on their behalf.
              </p>
            </div>

            <div className="modal-actions-footer">
              <button type="button" className="ghost" onClick={handleClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                data-testid="generate-invite-submit"
              >
                Generate Invitation <span>→</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="invite-result-view" data-testid="invite-generated-result">
            <div className="result-header">
              <span className="result-check">✓</span>
              <div>
                <h3>Invitation Ready to Share</h3>
                <p>Share this link or message with the prospective member.</p>
              </div>
            </div>

            <div className="result-section">
              <label className="field-label">
                Sharable Invitation Link
                <div className="copy-input-row">
                  <input
                    type="text"
                    className="text-input text-mono"
                    readOnly
                    data-testid="share-url-input"
                    value={createdInvite.shareUrl}
                  />
                  <button
                    type="button"
                    className="primary-small"
                    data-testid="copy-invite-link"
                    onClick={() => copyToClipboard(createdInvite.shareUrl, 'link')}
                  >
                    Copy Link
                  </button>
                </div>
              </label>
            </div>

            <div className="result-section">
              <label className="field-label">
                Ready-to-Send Email / Chat Message
                <textarea
                  className="textarea-input"
                  readOnly
                  rows={6}
                  data-testid="email-message-textarea"
                  value={createdInvite.emailMessage}
                />
              </label>
              <button
                type="button"
                className="secondary-btn"
                data-testid="copy-invite-email"
                onClick={() => copyToClipboard(createdInvite.emailMessage, 'message')}
              >
                Copy Message Text
              </button>
            </div>

            <div className="modal-actions-footer">
              <button
                type="button"
                className="ghost"
                onClick={resetModal}
              >
                ＋ Create Another
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleClose}
                data-testid="invite-done-btn"
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
