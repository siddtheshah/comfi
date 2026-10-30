import { useEffect, useMemo, useRef, useState } from 'react'
import { Connection } from '@solana/web3.js'
import { useWallet } from './wallet'
import { formatUsdc } from './solana'
import type { PoolItem } from './data'
import {
  buildGovernanceTransaction,
  fetchGovernance,
  type GovernanceSnapshot,
  type VotingMember,
} from './governance'

const short = (val: string) => (val && val.length > 10 ? `${val.slice(0, 4)}…${val.slice(-4)}` : val)

export function PeopleView({
  poolAddress,
  pool,
  walletAddress,
  onInvite,
  onRefreshPools,
}: {
  poolAddress: string
  pool: PoolItem
  walletAddress?: string
  onInvite?: () => void
  onRefreshPools?: () => void
}) {
  const wallet = useWallet()
  const source = `${wallet.endpoint}:${wallet.programId}:${poolAddress}:${wallet.publicKey ?? ''}`
  const sourceRef = useRef(source)
  sourceRef.current = source
  const revision = useRef(0)

  const [loaded, setLoaded] = useState<{ source: string; snapshot: GovernanceSnapshot } | null>(null)
  const snapshot = loaded?.source === source ? loaded.snapshot : null
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)

  // Internal tab within People view
  const [subTab, setSubTab] = useState<'directory' | 'lineage' | 'actions' | 'audit'>('directory')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)

  useEffect(() => {
    let disposed = false
    let pending = false
    setLoaded(null)
    setError('')
    setBusy(false)

    const load = async () => {
      if (pending) return
      pending = true
      const request = ++revision.current
      try {
        const result = await fetchGovernance(
          new Connection(wallet.endpoint, 'confirmed'),
          wallet.programId,
          poolAddress
        )
        if (!disposed && sourceRef.current === source && request === revision.current) {
          setLoaded({ source, snapshot: result })
          setError('')
        }
      } catch (failure) {
        if (!disposed && sourceRef.current === source) {
          setLoaded(null)
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        pending = false
      }
    }

    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [source, refresh, wallet.endpoint, wallet.programId, poolAddress])

  useEffect(() => {
    setMessage('')
  }, [source])

  const members: VotingMember[] = snapshot?.members ?? []
  const own = snapshot?.members.find((m) => m.wallet === wallet.publicKey)
  const canSign = wallet.connected && wallet.walletMode !== 'mock'

  const copyToClipboard = async (text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError('Clipboard is not supported in this environment.')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopiedAddress(text)
      setTimeout(() => setCopiedAddress(null), 2000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to copy address to clipboard: ${msg}`)
    }
  }

  const transact = async (
    operation:
      | { kind: 'set_paused'; paused: boolean }
      | { kind: 'leave_pool' }
      | { kind: 'claim_closure_refund' }
      | { kind: 'claim_eviction_refund' }
  ) => {
    if (!snapshot || !wallet.publicKey || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const fresh = await fetchGovernance(
        new Connection(wallet.endpoint, 'confirmed'),
        wallet.programId,
        poolAddress
      )
      if (sourceRef.current !== source) throw new Error('Wallet or network changed; retry.')

      const tx = buildGovernanceTransaction(wallet.programId, wallet.publicKey, fresh, operation)
      const signature = await wallet.sendTransaction(tx)
      if (sourceRef.current === source) {
        setMessage(`Confirmed transaction: ${signature}`)
        setConfirmLeave(false)
        setRefresh((n) => n + 1)
        onRefreshPools?.()
      }
    } catch (failure) {
      if (sourceRef.current === source) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (sourceRef.current === source) setBusy(false)
    }
  }

  // Filtered members list
  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const matchesSearch =
        search === '' ||
        m.wallet.toLowerCase().includes(search.toLowerCase()) ||
        m.address.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter === 'all' || m.status.toLowerCase() === statusFilter.toLowerCase()
      return matchesSearch && matchesStatus
    })
  }, [members, search, statusFilter])

  // Summary counts
  const activeCount = members.filter((m) => m.status === 'Active').length
  const fundedCount = members.filter((m) => m.isFunded && m.fundedCycle === pool.chain.currentCycle).length
  const maturedCount = members.filter((m) => m.isMaturedVoter).length
  const pausedCount = members.filter((m) => m.isPaused).length

  return (
    <section className="people-view" data-testid="people-view" aria-label="Community members directory">
      <div className="section-head">
        <div>
          <h2>Community Members</h2>
          <p>
            {members.length} member{members.length === 1 ? '' : 's'} enrolled ·{' '}
            {pool.cap - pool.slots} of {pool.cap} capacity filled
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {onInvite && (
            <button className="primary" data-testid="people-invite-btn" onClick={onInvite}>
              ＋ Invite Member
            </button>
          )}
          <button
            className="refresh-btn"
            disabled={busy}
            onClick={() => setRefresh((n) => n + 1)}
            title="Refresh member records"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="pool-error" role="alert">
          {error}
          <button className="outline" onClick={() => setRefresh((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {message && <p role="status" className="transaction-result toast-inline">{message}</p>}

      {/* Metric highlights */}
      <div className="people-stats-grid">
        <div className="people-stat-card">
          <small>Active Members</small>
          <strong>{activeCount}</strong>
          <em>{members.length - activeCount} leaving or evicted</em>
        </div>
        <div className="people-stat-card">
          <small>Current Funded</small>
          <strong>{fundedCount}</strong>
          <em>Cycle {pool.chain.currentCycle.toString()} eligible</em>
        </div>
        <div className="people-stat-card">
          <small>Matured Voters</small>
          <strong>{maturedCount}</strong>
          <em>Streak meets {pool.chain.metrics?.votingMaturationCycles.toString() ?? '0'} cycles</em>
        </div>
        <div className="people-stat-card">
          <small>Paused Rollovers</small>
          <strong>{pausedCount}</strong>
          <em>Exempt from next cycle</em>
        </div>
      </div>

      {/* People View sub-tabs */}
      <div className="people-subnav">
        <button
          className={subTab === 'directory' ? 'subnav-active' : ''}
          data-testid="subnav-directory"
          onClick={() => setSubTab('directory')}
        >
          Member Directory ({members.length})
        </button>
        <button
          className={subTab === 'lineage' ? 'subnav-active' : ''}
          data-testid="subnav-lineage"
          onClick={() => setSubTab('lineage')}
        >
          Vouch Lineage Tree
        </button>
        <button
          className={subTab === 'actions' ? 'subnav-active' : ''}
          data-testid="subnav-actions"
          onClick={() => setSubTab('actions')}
        >
          My Membership {own ? '✓' : ''}
        </button>
        <button
          className={subTab === 'audit' ? 'subnav-active' : ''}
          data-testid="subnav-audit"
          onClick={() => setSubTab('audit')}
        >
          Member Activity Log
        </button>
      </div>

      {!snapshot && !error && <p role="status">Loading member accounts from Solana…</p>}

      {/* Subtab 1: Directory */}
      {subTab === 'directory' && (
        <div className="people-directory-section">
          <div className="people-filter-bar">
            <input
              type="text"
              placeholder="Search by wallet address…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="people-search-input"
              data-testid="member-search-input"
            />
            <div className="filter-pills">
              {['all', 'active', 'leaving', 'evicted', 'exited'].map((s) => (
                <button
                  key={s}
                  className={`filter-pill ${statusFilter === s ? 'active' : ''}`}
                  onClick={() => setStatusFilter(s)}
                  data-testid={`filter-${s}`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {filteredMembers.length === 0 ? (
            <p className="no-members-msg">No members found matching your search.</p>
          ) : (
            <div className="member-cards-grid">
              {filteredMembers.map((m) => {
                const isYou = m.wallet === walletAddress
                const isFundedForCycle = m.isFunded && m.fundedCycle === pool.chain.currentCycle
                return (
                  <article
                    key={m.address}
                    className={`member-card ${isYou ? 'member-card-you' : ''}`}
                    data-testid={`member-card-${m.wallet}`}
                  >
                    <div className="member-card-header">
                      <div className="member-identity">
                        <span className={`avatar ${isYou ? 'you' : ''}`}>
                          {m.wallet.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <strong title={m.wallet}>
                              {short(m.wallet)}
                              {isYou && <span className="you-pill">You</span>}
                            </strong>
                            <button
                              className="copy-tiny-btn"
                              onClick={() => { void copyToClipboard(m.wallet) }}
                              title="Copy wallet address"
                            >
                              {copiedAddress === m.wallet ? '✓' : '⧉'}
                            </button>
                          </div>
                          <small className="pda-subtext" title={m.address}>
                            PDA: {short(m.address)}
                          </small>
                        </div>
                      </div>
                      <div className="member-badges">
                        <span className={`role-tag role-${m.role.toLowerCase()}`}>{m.role}</span>
                        <span className={`status-tag status-${m.status.toLowerCase()}`}>{m.status}</span>
                      </div>
                    </div>

                    <div className="member-metrics-grid">
                      <div>
                        <small>Cycle Standing</small>
                        <span className={`funded-pill ${isFundedForCycle ? 'funded-yes' : 'funded-no'}`}>
                          {isFundedForCycle ? 'Funded ✓' : 'Unfunded'}
                        </span>
                      </div>
                      <div>
                        <small>Funded Streak</small>
                        <strong>{m.fundedCycleStreak.toString()} cycle{m.fundedCycleStreak === 1n ? '' : 's'}</strong>
                      </div>
                      <div>
                        <small>Voter Maturation</small>
                        <span>
                          {m.isMaturedVoter ? (
                            <b className="matured-tag">Matured Voter ✓</b>
                          ) : (
                            `Maturing (${m.fundedCycleStreak.toString()}/${pool.chain.metrics?.votingMaturationCycles.toString() ?? '0'})`
                          )}
                        </span>
                      </div>
                      <div>
                        <small>Pause Rollover</small>
                        <span>{m.isPaused ? <span className="paused-tag">Paused</span> : 'Active'}</span>
                      </div>
                    </div>

                    <div className="member-finances">
                      <div>
                        <small>Total Contributions</small>
                        <span>{formatUsdc(m.totalContributions)}</span>
                      </div>
                      <div>
                        <small>Deposited Capital</small>
                        <span>{formatUsdc(m.depositedTotal)}</span>
                      </div>
                      <div>
                        <small>Surplus Amount</small>
                        <span>{formatUsdc(m.surplusAmount)}</span>
                      </div>
                      {m.claimableSurplusEscrow > 0n && (
                        <div>
                          <small>Escrowed Surplus</small>
                          <b className="escrow-highlight">{formatUsdc(m.claimableSurplusEscrow)}</b>
                        </div>
                      )}
                    </div>

                    <div className="member-card-foot">
                      {m.vouchedBy ? (
                        <span>
                          Vouched by <code title={m.vouchedBy}>{short(m.vouchedBy)}</code> (Depth {m.lineageDepth})
                        </span>
                      ) : (
                        <span>Founding Member (Depth {m.lineageDepth})</span>
                      )}
                      <span>Joined cycle {m.joinedCycle.toString()}</span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Subtab 2: Lineage Tree */}
      {subTab === 'lineage' && (
        <div className="lineage-tree-section" data-testid="lineage-section">
          <div className="lineage-intro">
            <h3>Vouch Lineage & Invitation Hierarchy</h3>
            <p>
              In ComFi's Sybil-resistant architecture, members vouch for new invitees. If an admitted member
              defaults, the voucher bears social accountability and reputation stake.
            </p>
          </div>

          <div className="lineage-tree-container">
            {members.length === 0 ? (
              <p>No member records loaded.</p>
            ) : (
              <div className="lineage-nodes-list">
                {/* Level 0: Roots / No voucher */}
                <div className="lineage-tier">
                  <span className="lineage-tier-label">Root & Founding Members (Depth 0)</span>
                  <div className="lineage-nodes-row">
                    {members
                      .filter((m) => !m.vouchedBy || m.lineageDepth === 0)
                      .map((root) => (
                        <div key={root.address} className="lineage-card root-node">
                          <div className="lineage-card-top">
                            <span className="avatar you">{root.wallet.slice(0, 2).toUpperCase()}</span>
                            <strong>{short(root.wallet)}</strong>
                          </div>
                          <span className="role-tag">{root.role}</span>
                          <small>Vouched for {root.vouchedCount} invitee{root.vouchedCount === 1 ? '' : 's'}</small>
                        </div>
                      ))}
                  </div>
                </div>

                {/* Level 1+: Vouched invitees */}
                {members.some((m) => m.vouchedBy && m.lineageDepth > 0) && (
                  <div className="lineage-tier">
                    <span className="lineage-tier-label">Vouched Invitees (Depth 1+)</span>
                    <div className="lineage-nodes-row">
                      {members
                        .filter((m) => m.vouchedBy && m.lineageDepth > 0)
                        .map((invitee) => (
                          <div key={invitee.address} className="lineage-card child-node">
                            <div className="lineage-card-top">
                              <span className="avatar">{invitee.wallet.slice(0, 2).toUpperCase()}</span>
                              <strong>{short(invitee.wallet)}</strong>
                            </div>
                            <span className="role-tag">{invitee.role}</span>
                            <div className="voucher-link">
                              ↳ Vouched by <code>{short(invitee.vouchedBy ?? '')}</code>
                            </div>
                            <small>Depth: {invitee.lineageDepth} · Streak: {invitee.fundedCycleStreak.toString()} cycles</small>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Subtab 3: My Membership & Actions */}
      {subTab === 'actions' && (
        <div className="my-membership-section" data-testid="my-membership-section">
          {!wallet.connected ? (
            <div className="empty-notice-card">
              <h3>Connect Your Wallet</h3>
              <p>Connect your wallet to inspect your pool membership and perform lifecycle actions.</p>
            </div>
          ) : !own ? (
            <div className="empty-notice-card">
              <h3>Not an Enrolled Member</h3>
              <p>
                Wallet <code>{wallet.publicKey}</code> does not currently hold a member account in this pool.
              </p>
              {onInvite && (
                <button className="primary" onClick={onInvite}>
                  Accept an Invite or Join Pool
                </button>
              )}
            </div>
          ) : (
            <div className="membership-control-panel">
              <div className="membership-overview-card">
                <h3>Your Membership Overview</h3>
                <div className="member-overview-grid">
                  <div>
                    <small>Your Role</small>
                    <strong>{own.role}</strong>
                  </div>
                  <div>
                    <small>Membership Status</small>
                    <strong className={`status-tag status-${own.status.toLowerCase()}`}>{own.status}</strong>
                  </div>
                  <div>
                    <small>Funded for Cycle {pool.chain.currentCycle.toString()}</small>
                    <strong>
                      {own.isFunded && own.fundedCycle === pool.chain.currentCycle ? 'Yes ✓' : 'No'}
                    </strong>
                  </div>
                  <div>
                    <small>Funded Streak</small>
                    <strong>{own.fundedCycleStreak.toString()} cycles</strong>
                  </div>
                  <div>
                    <small>Voting Standing</small>
                    <strong>{own.isMaturedVoter ? 'Matured Voter ✓' : 'Maturing'}</strong>
                  </div>
                  <div>
                    <small>Rollover Pause Status</small>
                    <strong>{own.isPaused ? 'Paused for Next Cycle' : 'Active'}</strong>
                  </div>
                  <div>
                    <small>Total Contributions</small>
                    <strong>{formatUsdc(own.totalContributions)}</strong>
                  </div>
                  <div>
                    <small>Surplus Balance</small>
                    <strong>{formatUsdc(own.surplusAmount)}</strong>
                  </div>
                  {own.claimableSurplusEscrow > 0n && (
                    <div>
                      <small>Escrowed Surplus</small>
                      <strong className="escrow-highlight">{formatUsdc(own.claimableSurplusEscrow)}</strong>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Cards */}
              <div className="lifecycle-actions-grid">
                {/* 1. Pause / Resume */}
                <div className="lifecycle-card">
                  <h4>Rollover Pause Status</h4>
                  <p>
                    {own.isPaused
                      ? 'You are currently paused. You will be exempt from funding obligations when the cycle rolls.'
                      : 'You are currently active. You will participate in automatic rollover for the next cycle.'}
                  </p>
                  <button
                    className="outline"
                    data-testid="toggle-pause-btn"
                    disabled={busy || !canSign || own.status !== 'Active'}
                    onClick={() => void transact({ kind: 'set_paused', paused: !own.isPaused })}
                  >
                    {own.isPaused ? '▶ Resume Rollover Participation' : '⏸ Pause Next Cycle Rollover'}
                  </button>
                </div>

                {/* 2. Leave Pool */}
                <div className="lifecycle-card">
                  <h4>Voluntary Departure</h4>
                  <p>
                    Initiate a clean departure from the pool. If you have unconsumed surplus, it will be refunded
                    to your wallet and you will be unlinked from the cycle rollover list.
                  </p>
                  {confirmLeave ? (
                    <div className="confirm-box">
                      <p className="confirm-warning">
                        Are you sure you want to leave this pool? This action cannot be undone.
                      </p>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          className="btn-danger-tiny"
                          data-testid="confirm-leave-btn"
                          disabled={busy || !canSign}
                          onClick={() => void transact({ kind: 'leave_pool' })}
                        >
                          Confirm & Leave Pool
                        </button>
                        <button className="btn-tiny" onClick={() => setConfirmLeave(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="outline btn-danger-tiny"
                      data-testid="leave-pool-btn"
                      disabled={busy || !canSign || own.status !== 'Active' || pool.chain.metrics?.isClosing}
                      onClick={() => setConfirmLeave(true)}
                    >
                      Leave Pool
                    </button>
                  )}
                </div>

                {/* 3. Closure Refund */}
                {pool.chain.metrics?.isClosing && (
                  <div className="lifecycle-card highlight-card">
                    <h4>Pool Closure Refund</h4>
                    <p>
                      The pool has entered formal closure settlement. You can claim your fair pro-rata share of
                      remaining pool capital and surplus.
                    </p>
                    <button
                      className="primary"
                      data-testid="claim-closure-refund-btn"
                      disabled={busy || !canSign || own.closureClaimed}
                      onClick={() => void transact({ kind: 'claim_closure_refund' })}
                    >
                      {own.closureClaimed ? 'Closure Refund Already Claimed ✓' : 'Claim Closure Refund'}
                    </button>
                  </div>
                )}

                {/* 4. Eviction Refund */}
                {own.status === 'Evicted' && own.claimableSurplusEscrow > 0n && (
                  <div className="lifecycle-card highlight-card">
                    <h4>Claim Eviction Refund</h4>
                    <p>
                      You have {formatUsdc(own.claimableSurplusEscrow)} in escrowed surplus available for claim
                      following eviction settlement.
                    </p>
                    <button
                      className="primary"
                      data-testid="claim-eviction-refund-btn"
                      disabled={busy || !canSign}
                      onClick={() => void transact({ kind: 'claim_eviction_refund' })}
                    >
                      Claim {formatUsdc(own.claimableSurplusEscrow)} Escrow
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Subtab 4: Audit History */}
      {subTab === 'audit' && (
        <div className="people-audit-section" data-testid="people-audit-section">
          <h3>Member Audit & Voting Records</h3>
          <p>Verified historical actions and governance engagement from on-chain accounts.</p>

          <div className="audit-timeline">
            {snapshot?.proposals.map((p) => {
              const proposerMember = members.find((m) => m.wallet === p.proposer)
              const votesOnProposal = snapshot.receipts.filter((r) => r.proposal === p.address)
              return (
                <div key={p.address} className="audit-event-card">
                  <div className="audit-event-header">
                    <strong>Proposal #{p.id.toString()}: {p.action.kind}</strong>
                    <span className={`tag proposal-${p.state.toLowerCase()}`}>{p.state}</span>
                  </div>
                  <p>
                    Submitted by {proposerMember ? short(proposerMember.wallet) : short(p.proposer)} ·{' '}
                    {votesOnProposal.length} member vote{votesOnProposal.length === 1 ? '' : 's'} recorded
                  </p>
                  {votesOnProposal.length > 0 && (
                    <div className="audit-votes-list">
                      <small>Participating voters:</small>
                      <div className="voter-pills-row">
                        {votesOnProposal.map((v, i) => (
                          <span key={i} className="voter-pill" title={v.voter}>
                            ✓ {short(v.voter)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {(!snapshot?.proposals || snapshot.proposals.length === 0) && (
              <p>No governance proposal history has been recorded yet.</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
