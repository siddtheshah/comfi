import { FC, FormEvent, useEffect, useMemo, useState } from 'react'
import type { PoolItem } from './data'
import { formatUsdc, quorumHealth } from './solana'
import type {
  AutonomyTier,
  CapabilityToggles,
  CopilotConfig,
  CopilotMessage,
  CopilotPoolSnapshot,
  DecisionAuditEntry,
} from './copilot-types'
import {
  DEFAULT_CAPABILITY_TOGGLES,
  DEFAULT_COPILOT_CONFIG,
  appendAuditEntry,
  clearAuditLog,
  evaluatePoolGovernance,
  loadAuditLog,
  loadCopilotConfig,
  processCopilotQuery,
  saveCopilotConfig,
} from './copilot-engine'

interface CopilotPanelProps {
  isOpen: boolean
  onClose: () => void
  selectedPool: PoolItem | null
  networkName: string
  walletConnected: boolean
  walletAddress?: string
  onExecuteProposal?: (proposalId: number) => Promise<void> | void
  onRollCycle?: () => Promise<void> | void
}

type Tab = 'chat' | 'autonomy' | 'audit' | 'insights'

export const CopilotPanel: FC<CopilotPanelProps> = ({
  isOpen,
  onClose,
  selectedPool,
  networkName,
  walletConnected,
  walletAddress,
  onExecuteProposal,
  onRollCycle,
}) => {
  const [tab, setTab] = useState<Tab>('chat')
  const [config, setConfig] = useState<CopilotConfig>(() => ({ ...loadCopilotConfig(), tier: 'advisory' }))
  const [auditLog, setAuditLog] = useState<DecisionAuditEntry[]>(() => loadAuditLog())
  const [queryInput, setQueryInput] = useState('')
  const [messages, setMessages] = useState<CopilotMessage[]>([
    {
      id: 'welcome-1',
      sender: 'assistant',
      timestamp: Date.now(),
      confidenceScore: 99,
      text: 'Hello! I am your ComFi Copilot. I can explain the loaded pool metrics and suggest actions. Transaction signing and proposal data are not connected yet.',
    },
  ])
  const [evaluating, setEvaluating] = useState(false)
  const [actionNotice, setActionNotice] = useState<string | null>(null)

  // Construct pool snapshot from selectedPool
  const poolSnapshot: CopilotPoolSnapshot | null = useMemo(() => {
    if (!selectedPool?.chain.metrics) return null
    const chain = selectedPool.chain
    const metrics = chain.metrics!
    return {
      id: selectedPool.id,
      name: selectedPool.name,
      address: chain.address,
      balance: chain.balanceUsdc,
      memberCount: chain.memberCount,
      memberCap: chain.memberCap,
      currentCycle: Number(chain.currentCycle),
      cycleStartedAt: Number(chain.cycleStartedAt),
      cycleDurationSeconds: Number(chain.cycleDurationSeconds),
      isLocked: metrics.isLocked,
      isClosing: metrics.isClosing,
      voteThreshold: chain.voteThreshold,
      votingPeriodSeconds: Number(chain.votingPeriodSeconds),
      totalSurplus: formatUsdc(metrics.totalNonConferredCapital),
    }
  }, [selectedPool])

  // Save config changes
  const updateConfig = (newConfig: CopilotConfig) => {
    setConfig(newConfig)
    saveCopilotConfig(newConfig)
  }

  const setTier = (tier: AutonomyTier) => {
    if (tier !== 'advisory') {
      setActionNotice('Automation is unavailable until transaction signing is connected.')
      return
    }
    updateConfig({ ...config, tier })
  }

  const toggleCapability = (key: keyof CapabilityToggles) => {
    updateConfig({
      ...config,
      toggles: {
        ...config.toggles,
        [key]: !config.toggles[key],
      },
    })
  }

  const handleClearAudit = () => {
    clearAuditLog()
    setAuditLog([])
  }

  // Run autonomous governance evaluation
  const runEvaluation = () => {
    if (!poolSnapshot) {
      setActionNotice('Please select an active pool to evaluate.')
      return
    }
    setEvaluating(true)
    try {
      const decisions = evaluatePoolGovernance(poolSnapshot, config)
      if (decisions.length === 0) {
        setActionNotice('No recommendations from the loaded pool metrics. Proposals and member refunds are not loaded.')
      } else {
        let currentLogs = auditLog
        for (const d of decisions) {
          currentLogs = appendAuditEntry(d)
        }
        setAuditLog(currentLogs)
        setActionNotice(`Evaluated ${decisions.length} decision(s) across quorum, cycles, and proposals.`)
      }
    } finally {
      setEvaluating(false)
    }
  }

  // Handle conversational query submission
  const handleQuerySubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = queryInput.trim()
    if (!trimmed) return

    const userMsg: CopilotMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      timestamp: Date.now(),
      text: trimmed,
    }

    const query = trimmed.toLowerCase()
    const metrics = selectedPool?.chain.metrics
    let assistantMsg: CopilotMessage
    if (/proposal|execute|vote|refund|claim|vouch|invite|pending|crank|run/.test(query)) {
      assistantMsg = { id: `msg-${Date.now()}`, sender: 'assistant', timestamp: Date.now(), text: 'Proposals, member refunds, and transaction signing are not connected yet. No transaction has been submitted.' }
    } else if (/quorum|participation|locked/.test(query) && metrics && selectedPool) {
      const health = quorumHealth(metrics, selectedPool.chain.memberCount)
      assistantMsg = { id: `msg-${Date.now()}`, sender: 'assistant', timestamp: Date.now(), text: `Funded participation: ${metrics.fundedMemberCount} / ${selectedPool.chain.memberCount} (${(health.participationBps / 100).toFixed(2)}%). Minimum: ${metrics.minQuorumMembers} members and ${(metrics.minQuorumBps / 100).toFixed(2)}%. Quorum ${health.satisfied ? 'satisfied' : 'below minimum'}. Pool ${metrics.isClosing ? 'closing' : metrics.isLocked ? 'locked' : 'unlocked'}.` }
    } else {
      assistantMsg = processCopilotQuery(trimmed, poolSnapshot, config)
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setQueryInput('')

    // Append to audit log if action suggestion exists
    if (assistantMsg.actionSuggestion) {
      const entry: DecisionAuditEntry = {
        id: `audit-query-${Date.now()}`,
        timestamp: Date.now(),
        tier: config.tier,
        actionType: assistantMsg.actionSuggestion.actionType,
        title: `Copilot Query: "${trimmed}"`,
        rationale: assistantMsg.text,
        confidenceScore: assistantMsg.confidenceScore ?? 95,
        status: 'recommended',
        poolId: poolSnapshot?.id,
        proposalId: assistantMsg.actionSuggestion.proposalId,
      }
      const updated = appendAuditEntry(entry)
      setAuditLog(updated)
    }
  }

  const handleSuggestedPrompt = (prompt: string) => {
    setQueryInput(prompt)
  }

  // Handle 1-click execution from copilot recommendations
  const handleExecuteSuggestion = async (suggestion: { label: string; actionType: DecisionAuditEntry['actionType']; proposalId?: number }) => {
    setActionNotice(`Executing ${suggestion.label}…`)
    try {
      if (suggestion.actionType === 'roll_cycle' && onRollCycle) {
        await onRollCycle()
      } else if (suggestion.actionType === 'execute_proposal' && suggestion.proposalId != null && onExecuteProposal) {
        await onExecuteProposal(suggestion.proposalId)
      } else {
        throw new Error('Transaction signing is not connected. No transaction has been submitted.')
      }
      const entry: DecisionAuditEntry = {
        id: `audit-exec-${Date.now()}`,
        timestamp: Date.now(),
        tier: config.tier,
        actionType: suggestion.actionType,
        title: `Executed: ${suggestion.label}`,
        rationale: 'User triggered 1-click execution directly via Copilot suggestion.',
        confidenceScore: 99,
        status: 'executed',
        poolId: poolSnapshot?.id,
        proposalId: suggestion.proposalId,
      }
      setAuditLog(appendAuditEntry(entry))
      setActionNotice(`Successfully executed: ${suggestion.label}`)
    } catch (err: unknown) {
      setActionNotice(err instanceof Error ? err.message : String(err))
    }
  }

  // Keyboard shortcut ESC
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const tierBadges = {
    advisory: { label: 'Tier 1: Advisory (Low Risk)', color: '#3182ce', bg: '#ebf8ff' },
    supervised: { label: 'Tier 2: Supervised (Medium Risk)', color: '#2b6cb0', bg: '#edf2f7' },
    autonomous: { label: 'Tier 3: Autonomous (Full Delegation)', color: '#276749', bg: '#e6fffa' },
  }

  return (
    <div className="copilot-overlay" data-testid="copilot-panel">
      <div className="copilot-container">
        {/* Header */}
        <header className="copilot-header">
          <div className="copilot-header-brand">
            <div className="copilot-brand-icon">🤖</div>
            <div>
              <div className="copilot-brand-title">
                <h2>ComFi Copilot</h2>
                <span
                  className="copilot-tier-pill"
                  style={{
                    color: tierBadges[config.tier].color,
                    backgroundColor: tierBadges[config.tier].bg,
                  }}
                >
                  {tierBadges[config.tier].label}
                </span>
              </div>
              <p className="copilot-subtitle">
                Autonomous Delegated Pool Assistant · {networkName}
              </p>
            </div>
          </div>
          <div className="copilot-header-actions">
            <button
              className="copilot-eval-btn"
              onClick={runEvaluation}
              disabled={evaluating}
              title="Audit quorum, cycles, and proposals"
            >
              ⚡ {evaluating ? 'Analyzing…' : 'Run Audit'}
            </button>
            <button className="copilot-close-btn" onClick={onClose} aria-label="Close Copilot">
              ×
            </button>
          </div>
        </header>

        {/* Action Notice */}
        {actionNotice && (
          <div className="copilot-notice">
            <span>{actionNotice}</span>
            <button onClick={() => setActionNotice(null)}>×</button>
          </div>
        )}

        {/* Tabs */}
        <nav className="copilot-tabs">
          <button
            className={`copilot-tab ${tab === 'chat' ? 'active' : ''}`}
            onClick={() => setTab('chat')}
          >
            💬 Assistant
          </button>
          <button
            className={`copilot-tab ${tab === 'autonomy' ? 'active' : ''}`}
            onClick={() => setTab('autonomy')}
          >
            ⚙️ Autonomy & Risk
          </button>
          <button
            className={`copilot-tab ${tab === 'audit' ? 'active' : ''}`}
            onClick={() => setTab('audit')}
          >
            📜 Audit Log ({auditLog.length})
          </button>
          <button
            className={`copilot-tab ${tab === 'insights' ? 'active' : ''}`}
            onClick={() => setTab('insights')}
          >
            📊 Pool Insights
          </button>
        </nav>

        {/* Content Body */}
        <div className="copilot-body">
          <p className="copilot-section-desc">Advisory only. Proposals and member refunds are not loaded; transaction signing is not connected.</p>
          {/* TAB 1: Conversational Chat */}
          {tab === 'chat' && (
            <div className="copilot-chat-view">
              <div className="copilot-messages-list">
                {messages.map(msg => (
                  <div key={msg.id} className={`copilot-msg-bubble ${msg.sender}`}>
                    <div className="copilot-msg-header">
                      <strong>{msg.sender === 'user' ? 'You' : 'ComFi Copilot'}</strong>
                      {msg.confidenceScore != null && (
                        <span className="copilot-confidence-pill">
                          {msg.confidenceScore}% confidence
                        </span>
                      )}
                    </div>
                    <p className="copilot-msg-text">{msg.text}</p>
                    {msg.actionSuggestion && (
                      <div className="copilot-msg-action">
                        <button
                          className="copilot-action-exec-btn"
                          disabled={!onRollCycle && !onExecuteProposal}
                          onClick={() => handleExecuteSuggestion(msg.actionSuggestion!)}
                        >
                          ▶ {msg.actionSuggestion.label}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Suggested Prompts */}
              <div className="copilot-suggested-prompts">
                <span className="copilot-suggest-label">Suggested:</span>
                <button
                  className="copilot-chip"
                  onClick={() => handleSuggestedPrompt('What is our quorum status?')}
                >
                  What is our quorum status?
                </button>
                <button
                  className="copilot-chip"
                  onClick={() => handleSuggestedPrompt('Are there pending proposals to vote on?')}
                >
                  Pending proposals to vote on?
                </button>
                <button
                  className="copilot-chip"
                  onClick={() => handleSuggestedPrompt('Execute passed proposals')}
                >
                  Execute passed proposals
                </button>
                <button
                  className="copilot-chip"
                  onClick={() => handleSuggestedPrompt('What is our cycle deadline?')}
                >
                  Cycle deadline
                </button>
              </div>

              {/* Chat Input Form */}
              <form className="copilot-chat-form" onSubmit={handleQuerySubmit}>
                <input
                  type="text"
                  className="copilot-chat-input"
                  placeholder="Ask Copilot about quorum, proposals, cycle renewals…"
                  value={queryInput}
                  onChange={e => setQueryInput(e.target.value)}
                />
                <button type="submit" className="copilot-send-btn" disabled={!queryInput.trim()}>
                  Send
                </button>
              </form>
            </div>
          )}

          {/* TAB 2: Autonomy & Risk Settings */}
          {tab === 'autonomy' && (
            <div className="copilot-settings-view">
              <section className="copilot-section">
                <h3 className="copilot-section-title">Autonomy & Risk Tiers</h3>
                <p className="copilot-section-desc">
                  Select the level of autonomous authority granted to ComFi Copilot for executing
                  smart contract instructions on your behalf.
                </p>

                <div className="copilot-tiers-grid">
                  {/* Tier 1 */}
                  <div
                    className={`copilot-tier-card ${config.tier === 'advisory' ? 'selected' : ''}`}
                    onClick={() => setTier('advisory')}
                  >
                    <div className="copilot-tier-card-head">
                      <span className="copilot-tier-name">Tier 1: Advisory Mode</span>
                      <span className="copilot-risk-badge low">Low Risk / Zero Autonomy</span>
                    </div>
                    <p className="copilot-tier-desc">
                      Proactively monitors pool metrics, flags quorum drops, highlights executable
                      proposals, and recommends votes without executing transactions.
                    </p>
                  </div>

                  {/* Tier 2 */}
                  <div
                    className={`copilot-tier-card ${config.tier === 'supervised' ? 'selected' : ''}`}
                    onClick={() => setTier('supervised')}
                  >
                    <div className="copilot-tier-card-head">
                      <span className="copilot-tier-name">Tier 2: Supervised Automation</span>
                      <span className="copilot-risk-badge med">Medium Risk / Semi-Autonomous</span>
                    </div>
                    <p className="copilot-tier-desc">
                      Auto-votes on recurring routine proposals matching user rules, auto-rolls overdue
                      cycles, and prompts for approval on large spends, evictions, or config modifications.
                    </p>
                  </div>

                  {/* Tier 3 */}
                  <div
                    className={`copilot-tier-card ${config.tier === 'autonomous' ? 'selected' : ''}`}
                    onClick={() => setTier('autonomous')}
                  >
                    <div className="copilot-tier-card-head">
                      <span className="copilot-tier-name">Tier 3: Autonomous Delegation</span>
                      <span className="copilot-risk-badge high">High Risk / Full Autonomy</span>
                    </div>
                    <p className="copilot-tier-desc">
                      Automatically cranks cycle rolls, executes passed proposals, and auto-vouches
                      verified invited candidate addresses via the webhook pipeline.
                    </p>
                  </div>
                </div>
              </section>

              <section className="copilot-section">
                <h3 className="copilot-section-title">Granular Capability Toggles</h3>
                <p className="copilot-section-desc">
                  Configure specific permissions delegated to the Copilot background crank.
                </p>

                <div className="copilot-toggles-list">
                  <label className="copilot-toggle-item">
                    <input
                      type="checkbox"
                      disabled
                      checked={config.toggles.autoRollCycle}
                      onChange={() => toggleCapability('autoRollCycle')}
                    />
                    <div>
                      <strong>Auto-roll cycle when deadline passes</strong>
                      <small>Executes cycle advance immediately upon voting period deadline expiry.</small>
                    </div>
                  </label>

                  <label className="copilot-toggle-item">
                    <input
                      type="checkbox"
                      disabled
                      checked={config.toggles.autoExecutePassedProposals}
                      onChange={() => toggleCapability('autoExecutePassedProposals')}
                    />
                    <div>
                      <strong>Auto-execute passed proposals</strong>
                      <small>Dispatches execution transactions for proposals meeting threshold.</small>
                    </div>
                  </label>

                  <label className="copilot-toggle-item">
                    <input
                      type="checkbox"
                      disabled
                      checked={config.toggles.autoVouchCandidates}
                      onChange={() => toggleCapability('autoVouchCandidates')}
                    />
                    <div>
                      <strong>Auto-vouch invited candidates from webhook responses</strong>
                      <small>Signs admit vouches for accepted candidate invite links automatically.</small>
                    </div>
                  </label>

                  <label className="copilot-toggle-item">
                    <input
                      type="checkbox"
                      disabled
                      checked={config.toggles.autoVoteLineageYes}
                      onChange={() => toggleCapability('autoVoteLineageYes')}
                    />
                    <div>
                      <strong>Auto-vote YES on vouched candidates in user lineage</strong>
                      <small>Backs network partners with automated affirmative governance votes.</small>
                    </div>
                  </label>

                  <label className="copilot-toggle-item">
                    <input
                      type="checkbox"
                      disabled
                      checked={config.toggles.autoClaimSurplusRefund}
                      onChange={() => toggleCapability('autoClaimSurplusRefund')}
                    />
                    <div>
                      <strong>Auto-claim surplus or refund upon pool closure</strong>
                      <small>Collects pro-rata surplus escrows to your wallet during pool sunset.</small>
                    </div>
                  </label>
                </div>
              </section>
            </div>
          )}

          {/* TAB 3: Decision & Audit Log */}
          {tab === 'audit' && (
            <div className="copilot-audit-view">
              <div className="copilot-audit-head">
                <div>
                  <h3 className="copilot-section-title">Autonomous Decision & Audit Log</h3>
                  <p className="copilot-section-desc">
                    Real-time immutable log of evaluated governance conditions, confidence scores, and
                    dispatched transactions.
                  </p>
                </div>
                {auditLog.length > 0 && (
                  <button className="copilot-clear-btn" onClick={handleClearAudit}>
                    Clear Log
                  </button>
                )}
              </div>

              {auditLog.length === 0 ? (
                <div className="copilot-empty-state">
                  <p>No audit decisions recorded yet.</p>
                  <button className="copilot-eval-btn" onClick={runEvaluation}>
                    ⚡ Run Governance Evaluation
                  </button>
                </div>
              ) : (
                <div className="copilot-audit-stream">
                  {auditLog.map(entry => (
                    <div key={entry.id} className={`copilot-audit-entry ${entry.status}`}>
                      <div className="copilot-audit-entry-top">
                        <span className={`copilot-status-badge ${entry.status}`}>
                          {entry.status.toUpperCase()}
                        </span>
                        <strong className="copilot-audit-title">{entry.title}</strong>
                        <span className="copilot-audit-time">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="copilot-audit-rationale">{entry.rationale}</p>
                      <div className="copilot-audit-meta">
                        <span className="copilot-score-chip">
                          Confidence: <b>{entry.confidenceScore}%</b>
                        </span>
                        <span className="copilot-tier-chip">Tier: {entry.tier}</span>
                        {entry.proposalId != null && (
                          <span className="copilot-prop-chip">Proposal #{entry.proposalId}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: Pool Insights */}
          {tab === 'insights' && (
            <div className="copilot-insights-view">
              <h3 className="copilot-section-title">Live Pool Governance Telemetry</h3>
              {poolSnapshot ? (
                <div className="copilot-insights-grid">
                  <div className="copilot-insight-card">
                    <small>Active Pool</small>
                    <strong>{poolSnapshot.name}</strong>
                    <span>Address: {poolSnapshot.address?.slice(0, 6)}…{poolSnapshot.address?.slice(-6)}</span>
                  </div>

                  <div className="copilot-insight-card">
                    <small>Quorum Participation</small>
                    <strong>
                      {poolSnapshot.memberCount} / {poolSnapshot.memberCap} Members
                    </strong>
                    <span>Vote Threshold: {poolSnapshot.voteThreshold} votes</span>
                  </div>

                  <div className="copilot-insight-card">
                    <small>Cycle Schedule</small>
                    <strong>Cycle #{poolSnapshot.currentCycle}</strong>
                    <span>Duration: {poolSnapshot.cycleDurationSeconds} seconds</span>
                  </div>

                  <div className="copilot-insight-card">
                    <small>Active Proposals</small>
                    <strong>Not loaded</strong>
                    <span>Proposal lifecycle integration is pending.</span>
                  </div>
                </div>
              ) : (
                <div className="copilot-empty-state">
                  <p>Select a pool with a current account layout to inspect its metrics.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
