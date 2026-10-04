import { FC, FormEvent, useState } from 'react'
import type { AdmissionMode, CreatePoolModalParams } from './invitation-types'

interface CreatePoolModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (params: CreatePoolModalParams) => Promise<void> | void
  creating: boolean
}

export const CreatePoolModal: FC<CreatePoolModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  creating,
}) => {
  const [name, setName] = useState('Mutual Aid Circle')
  const [admissionMode, setAdmissionMode] = useState<AdmissionMode>('InviteVouched')
  const [memberObligationAmount, setMemberObligationAmount] = useState(10)
  const [minimumDeposit, setMinimumDeposit] = useState(10)
  const [cycleDurationDays, setCycleDurationDays] = useState(30)
  const [memberCap, setMemberCap] = useState(24)
  const [voteThresholdBps, setVoteThresholdBps] = useState(5001)
  const [minQuorumMembers, setMinQuorumMembers] = useState(2)
  const [autoCloseCyclesThreshold, setAutoCloseCyclesThreshold] = useState(0)
  const [executionMode, setExecutionMode] = useState<'on_deadline' | 'threshold_met'>('on_deadline')
  const [validationError, setValidationError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setValidationError(null)

    if (!name.trim()) {
      setValidationError('Pool name is required.')
      return
    }
    if (memberObligationAmount <= 0 || isNaN(memberObligationAmount)) {
      setValidationError('Member obligation amount must be greater than 0.')
      return
    }
    if (minimumDeposit <= 0 || isNaN(minimumDeposit)) {
      setValidationError('Minimum initial deposit must be greater than 0.')
      return
    }
    if (cycleDurationDays <= 0 || isNaN(cycleDurationDays)) {
      setValidationError('Cycle duration must be greater than 0 days.')
      return
    }
    if (memberCap < 2 || isNaN(memberCap)) {
      setValidationError('Member capacity must be at least 2 members.')
      return
    }
    if (voteThresholdBps < 5001 || voteThresholdBps > 10000 || isNaN(voteThresholdBps)) {
      setValidationError('Vote threshold must be between 5001 bps (50.01%) and 10000 bps (100%).')
      return
    }
    if (minQuorumMembers < 1 || isNaN(minQuorumMembers)) {
      setValidationError('Minimum quorum members must be at least 1.')
      return
    }
    if (autoCloseCyclesThreshold < 0 || isNaN(autoCloseCyclesThreshold)) {
      setValidationError('Auto-close cycles threshold cannot be negative.')
      return
    }

    void onSubmit({
      name: name.trim(),
      admissionMode,
      memberObligationAmount,
      minimumDeposit,
      cycleDurationDays,
      memberCap,
      voteThresholdBps,
      minQuorumMembers,
      autoCloseCyclesThreshold,
      executionMode,
    })
  }

  return (
    <div className="wallet-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="create-pool-modal-title">
      <div className="create-pool-modal-card" data-testid="create-pool-modal">
        <div className="wallet-modal-header">
          <div>
            <div className="wallet-modal-badge">
              <span className="network-dot" />
              <span>Pool Governance & Architecture</span>
            </div>
            <h2 id="create-pool-modal-title">Create a Community Pool</h2>
          </div>
          <button
            className="wallet-modal-close"
            onClick={onClose}
            aria-label="Close modal"
            data-testid="create-pool-modal-close"
          >
            ✕
          </button>
        </div>

        {validationError && (
          <div className="wallet-alert error" role="alert">
            <span>{validationError}</span>
            <button onClick={() => setValidationError(null)}>✕</button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="create-pool-form">
          <div className="form-section">
            <label className="field-label">
              Pool Name
              <input
                type="text"
                className="text-input"
                data-testid="create-pool-name-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Mutual Aid Circle, Dev Cooperative"
                required
              />
            </label>
          </div>

          <div className="form-section">
            <span className="section-label">Admission Mode</span>
            <p className="field-hint">Choose how prospective members are admitted to your pool:</p>
            <div className="mode-selection-grid">
              <button
                type="button"
                className={`mode-card ${admissionMode === 'InviteVouched' ? 'selected' : ''}`}
                data-testid="mode-invite-vouched"
                onClick={() => setAdmissionMode('InviteVouched')}
              >
                <div className="mode-card-header">
                  <strong>Invite & Vouched Only</strong>
                  <span className="tag onchain">Recommended</span>
                </div>
                <p>
                  Prospective members must receive an invitation and be admitted through an <code>AdmitMember</code> governance proposal vouched by an existing member.
                </p>
              </button>

              <button
                type="button"
                className={`mode-card ${admissionMode === 'Open' ? 'selected' : ''}`}
                data-testid="mode-open"
                onClick={() => setAdmissionMode('Open')}
              >
                <div className="mode-card-header">
                  <strong>Open Membership</strong>
                  <span className="tag">Permissionless</span>
                </div>
                <p>
                  Anyone with a supported Solana wallet can deposit the minimum contribution and join the pool immediately without proposals.
                </p>
              </button>
            </div>
          </div>

          <div className="form-grid-2">
            <label className="field-label">
              Member Obligation ($ USDC / cycle)
              <input
                type="number"
                className="text-input"
                data-testid="create-pool-obligation-input"
                min="1"
                step="0.01"
                value={memberObligationAmount}
                onChange={e => setMemberObligationAmount(parseFloat(e.target.value) || 0)}
                required
              />
              <small>Required contribution due each cycle</small>
            </label>

            <label className="field-label">
              Minimum Initial Deposit ($ USDC)
              <input
                type="number"
                className="text-input"
                data-testid="create-pool-min-deposit-input"
                min="1"
                step="0.01"
                value={minimumDeposit}
                onChange={e => setMinimumDeposit(parseFloat(e.target.value) || 0)}
                required
              />
              <small>Initial capital required to join</small>
            </label>
          </div>

          <div className="form-grid-2">
            <label className="field-label">
              Cycle Duration
              <select
                className="select-input"
                data-testid="create-pool-duration-select"
                value={cycleDurationDays}
                onChange={e => setCycleDurationDays(parseInt(e.target.value, 10))}
              >
                <option value={7}>7 Days (Weekly)</option>
                <option value={14}>14 Days (Bi-weekly)</option>
                <option value={30}>30 Days (Monthly - Recommended)</option>
                <option value={60}>60 Days (Bi-monthly)</option>
                <option value={90}>90 Days (Quarterly)</option>
              </select>
              <small>Duration before cycles roll over</small>
            </label>

            <label className="field-label">
              Member Capacity
              <input
                type="number"
                className="text-input"
                data-testid="create-pool-cap-input"
                min="2"
                max="500"
                value={memberCap}
                onChange={e => setMemberCap(parseInt(e.target.value, 10) || 2)}
                required
              />
              <small>Maximum members allowed in pool</small>
            </label>
          </div>

          <div className="form-section">
            <span className="section-label">Quorum & Governance Parameters</span>
            <div className="form-grid-3">
              <label className="field-label">
                Quorum Threshold
                <select
                  className="select-input"
                  data-testid="create-pool-threshold-select"
                  value={voteThresholdBps}
                  onChange={e => setVoteThresholdBps(parseInt(e.target.value, 10))}
                >
                  <option value={5001}>50.01% (Simple Majority - 5001 bps)</option>
                  <option value={6000}>60.00% (6000 bps)</option>
                  <option value={6667}>66.67% (2/3 Supermajority - 6667 bps)</option>
                  <option value={7500}>75.00% (7500 bps)</option>
                </select>
                <small>Required votes to pass</small>
              </label>

              <label className="field-label">
                Min Quorum Members
                <input
                  type="number"
                  className="text-input"
                  data-testid="create-pool-min-members-input"
                  min="1"
                  max="50"
                  value={minQuorumMembers}
                  onChange={e => setMinQuorumMembers(parseInt(e.target.value, 10) || 1)}
                  required
                />
                <small>Minimum voting participants</small>
              </label>

              <label className="field-label">
                Auto-Close Cycles
                <input
                  type="number"
                  className="text-input"
                  data-testid="create-pool-autoclose-input"
                  min="0"
                  max="20"
                  value={autoCloseCyclesThreshold}
                  onChange={e => setAutoCloseCyclesThreshold(parseInt(e.target.value, 10) || 0)}
                />
                <small>0 = disabled (consecutive locked cycles)</small>
              </label>
            </div>
          </div>

          <div className="form-section">
            <label className="field-label">
              Proposal Execution Mode
              <select
                className="select-input"
                data-testid="create-pool-execution-mode-select"
                value={executionMode}
                onChange={e => setExecutionMode(e.target.value as 'on_deadline' | 'threshold_met')}
              >
                <option value="on_deadline">Execute on Deadline (Standard Timelock)</option>
                <option value="threshold_met">Execute Immediately When Threshold Met</option>
              </select>
            </label>
          </div>

          <div className="modal-actions-footer">
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              data-testid="create-pool-modal-submit"
              disabled={creating}
            >
              {creating ? 'Deploying Pool…' : <>Deploy Pool <span>→</span></>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
