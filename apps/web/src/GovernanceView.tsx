import { useEffect, useRef, useState } from 'react'
import { Connection } from '@solana/web3.js'
import { useWallet } from './wallet'
import { formatUsdc } from './solana'
import { buildGovernanceTransaction, fetchGovernance, parseUsdc, proposalEligibility, proposalKinds, votingPower, type GovernanceSnapshot, type Proposal, type ProposalAction, type ProposalKind } from './governance'

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-6)}`
function actionDetails(a: ProposalAction) {
  switch (a.kind) {
    case 'SetSpenderLimit': return `${short(a.member)} · ${formatUsdc(a.cap)} per cycle`
    case 'ApproveWithdrawal': return `Withdrawal request ${short(a.request)}`
    case 'EvictMember': return `Remove member ${short(a.member)}; refundable capital is preserved.`
    case 'AdmitMember': return `Admit ${short(a.candidateWallet)} · vouched by ${short(a.vouchedBy)}`
    case 'ClosePool': return 'Close the pool and enable member closure refunds.'
    case 'ConfigurationModification': return `Threshold ${(a.voteThreshold / 100).toFixed(2)}% · ${a.cycleDurationSeconds} second cycles · ${formatUsdc(a.memberObligationAmount)} obligation · deadlines ${a.spenderLimitDeadlineCycles}/${a.withdrawalDeadlineCycles}/${a.configModificationDeadlineCycles} cycles · execution ${a.spenderLimitExecutionMode}/${a.withdrawalExecutionMode}/${a.configModificationExecutionMode}`
  }
}
export function GovernanceView({ address }: { address: string }) {
  const wallet = useWallet()
  const source = `${wallet.endpoint}:${wallet.programId}:${address}:${wallet.publicKey ?? ''}`
  const sourceRef = useRef(source); sourceRef.current = source
  const revision = useRef(0)
  const [loaded, setLoaded] = useState<{ source: string; snapshot: GovernanceSnapshot } | null>(null)
  const snapshot = loaded?.source === source ? loaded.snapshot : null
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [vote, setVote] = useState<Proposal | null>(null), [creating, setCreating] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false
    let pending = false
    setLoaded(null); setError(''); setVote(null); setCreating(false); setBusy(false)
    const load = async () => {
      if (pending) return
      pending = true
      const request = ++revision.current
      try {
        const result = await fetchGovernance(new Connection(wallet.endpoint, 'confirmed'), wallet.programId, address)
        if (!disposed && sourceRef.current === source && request === revision.current) { setLoaded({ source, snapshot: result }); setError('') }
      } catch (failure) {
        if (!disposed && sourceRef.current === source) { setLoaded(null); setError(failure instanceof Error ? failure.message : String(failure)) }
      } finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [source, refresh, wallet.endpoint, wallet.programId, address])
  useEffect(() => { setMessage('') }, [source])
  const own = snapshot?.members.find(m => m.wallet === wallet.publicKey)
  const canSign = wallet.connected && wallet.walletMode !== 'mock'
  const transact = async (operation: Parameters<typeof buildGovernanceTransaction>[3]) => {
    if (!snapshot || !wallet.publicKey || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      // Re-read chain state before requesting the wallet signature.
      const fresh = await fetchGovernance(new Connection(wallet.endpoint, 'confirmed'), wallet.programId, address)
      if (sourceRef.current !== source) throw new Error('Wallet or network changed; retry.')
      const op = operation.kind === 'create' ? operation : { ...operation, proposal: fresh.proposals.find(p => p.address === operation.proposal.address)! }
      if (op.kind !== 'create' && !op.proposal) throw new Error('Proposal no longer exists; refresh.')
      const tx = buildGovernanceTransaction(wallet.programId, wallet.publicKey, fresh, op)
      const signature = await wallet.sendTransaction(tx)
      if (sourceRef.current === source) { setMessage(`Confirmed transaction: ${signature}`); setVote(null); setCreating(false); setRefresh(n => n + 1) }
    } catch (failure) {
      if (sourceRef.current === source) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (sourceRef.current === source) setBusy(false) }
  }
  return <section className="governance-view" aria-label="Governance and proposals">
    <div className="section-head"><div><h2>Governance & proposals</h2><p>Live chain state · refreshes every 10 seconds</p></div><button className="primary" disabled={!snapshot || !snapshot.pool.metrics || !canSign || busy} onClick={() => setCreating(true)}>Create Proposal</button></div>
    {!canSign && <p>Select and connect ComFi Wallet, Phantom or Backpack to sign governance transactions.</p>}
    {error && <p className="pool-error" role="alert">{error}<button className="outline" onClick={() => setRefresh(n => n + 1)}>Retry</button></p>}
    {message && <p role="status" className="transaction-result">{message}</p>}
    {!snapshot && !error && <p role="status">Loading governance…</p>}
    {snapshot && !snapshot.pool.metrics && <p>Governance is unavailable for this legacy pool layout.</p>}
    {snapshot?.pool.metrics && <>
      {snapshot.proposals.length === 0 && <p>No proposals have been created.</p>}
      {snapshot.proposals.map(p => {
        const eligibility = proposalEligibility(snapshot.pool, p, snapshot.now)
        const power = votingPower(snapshot.pool, own, p.action)
        const voted = snapshot.receipts.some(r => r.proposal === p.address && r.voter === own?.address)
        return <article className="governance-proposal" key={p.address}>
          <div className="section-head compact"><h3>#{p.id.toString()} · {p.action.kind}</h3><span className={`tag proposal-${p.state.toLowerCase()}`}>{eligibility.status}</span></div>
          <p>{actionDetails(p.action)}</p><p title={p.address}>Proposal: {p.address}</p>
          <p>YES {p.yesVotes} · NO {p.noVotes} · {eligibility.required} YES required, with more YES than NO</p>
          <p>Voting cycles {p.votingCycle.toString()}–{p.deadlineCycle.toString()} · Current cycle {snapshot.pool.currentCycle.toString()} · {p.executionMode === 'threshold_met' ? 'Finalize when threshold is met or after deadline' : 'Finalize after deadline cycle'}</p>
          {p.state === 'Executable' && <p>Execution from cycle {p.executableCycle.toString()} and {new Date(Number(p.executableAfter) * 1000).toLocaleString()} · {eligibility.canExecute ? 'Ready' : 'Waiting for delay or pool eligibility'}</p>}
          {!eligibility.cycleCurrent && <p className="pool-warning">Cycle rollover is required before governance transactions.</p>}
          <div className="governance-actions">
            <button className="outline" disabled={busy || !canSign || !eligibility.canVote || !power.eligible || voted} onClick={() => setVote(p)}>{voted ? 'Already voted' : 'Vote'}</button>
            <button className="outline" disabled={busy || !canSign || !eligibility.canFinalize} onClick={() => void transact({ kind: 'finalize', proposal: p })}>Finalize result</button>
            <button className="primary" disabled={busy || !canSign || !eligibility.canExecute || (p.action.kind === 'ApproveWithdrawal' && !own)} onClick={() => void transact({ kind: 'execute', proposal: p })}>Execute proposal</button>
          </div>
          {!power.eligible && <small>{power.reason}</small>}
        </article>
      })}
      {vote && <div className="governance-overlay"><section className="governance-dialog" role="dialog" aria-modal="true" aria-labelledby="vote-title"><h2 id="vote-title">Vote on #{vote.id.toString()} · {vote.action.kind}</h2>
        <p>{actionDetails(vote.action)}</p>{error && <p role="alert">{error}</p>}{busy && <p role="status">Awaiting wallet approval and chain confirmation…</p>}<dl><dt>Current cycle funded</dt><dd>{own?.isFunded && own.fundedCycle === snapshot.pool.currentCycle ? 'Yes' : 'No'}</dd><dt>Funded streak</dt><dd>{own?.fundedCycleStreak.toString() ?? '0'} cycles</dd><dt>Maturation</dt><dd>{own?.isMaturedVoter ? 'Matured voter' : 'Not matured'} · required streak {snapshot.pool.metrics.votingMaturationCycles.toString()} cycles</dd></dl>
        <p>{votingPower(snapshot.pool, own, vote.action).reason}</p>
        <div className="governance-actions"><button className="primary" disabled={busy} onClick={() => void transact({ kind: 'vote', proposal: vote, approve: true })}>Vote YES</button><button className="outline" disabled={busy} onClick={() => void transact({ kind: 'vote', proposal: vote, approve: false })}>Vote NO</button><button className="outline" disabled={busy} onClick={() => setVote(null)}>Cancel</button></div>
      </section></div>}
      {creating && <CreateProposal snapshot={snapshot} ownAddress={own?.wallet ?? ''} busy={busy} transactionError={error} close={() => setCreating(false)} submit={action => void transact({ kind: 'create', action })} />}
    </>}
    {busy && <p role="status">Awaiting wallet approval and chain confirmation…</p>}
  </section>
}
function CreateProposal({ snapshot, ownAddress, busy, transactionError, close, submit }: { transactionError: string; snapshot: GovernanceSnapshot; ownAddress: string; busy: boolean; close: () => void; submit: (action: ProposalAction) => void }) {
  const pool = snapshot.pool
  const [kind, setKind] = useState<ProposalKind>('SetSpenderLimit'), [target, setTarget] = useState(''), [amount, setAmount] = useState('100'), [candidate, setCandidate] = useState(''), [vouch] = useState(ownAddress), [error, setError] = useState('')
  const [config, setConfig] = useState({ voteThreshold: pool.voteThreshold.toString(), cycleDurationSeconds: pool.cycleDurationSeconds.toString(), memberObligationAmount: (pool.memberObligationAmountAtomic / 1_000_000n).toString() + '.' + (pool.memberObligationAmountAtomic % 1_000_000n).toString().padStart(6,'0'), spenderLimitDeadlineCycles: pool.spenderLimitDeadlineCycles.toString(), withdrawalDeadlineCycles: pool.withdrawalDeadlineCycles.toString(), configModificationDeadlineCycles: pool.configModificationDeadlineCycles.toString(), spenderLimitExecutionMode: pool.spenderLimitExecutionMode, withdrawalExecutionMode: pool.withdrawalExecutionMode, configModificationExecutionMode: pool.configModificationExecutionMode })
  const action = (): ProposalAction => {
    switch (kind) {
      case 'ClosePool': return { kind }
      case 'SetSpenderLimit': return { kind, member: target, cap: parseUsdc(amount) }
      case 'EvictMember': return { kind, member: target }
      case 'ApproveWithdrawal': return { kind, request: target }
      case 'AdmitMember': return { kind, candidateWallet: candidate.trim(), vouchedBy: vouch }
      case 'ConfigurationModification': return { kind, voteThreshold: Number(config.voteThreshold), cycleDurationSeconds: BigInt(config.cycleDurationSeconds), memberObligationAmount: parseUsdc(config.memberObligationAmount), spenderLimitDeadlineCycles: BigInt(config.spenderLimitDeadlineCycles), withdrawalDeadlineCycles: BigInt(config.withdrawalDeadlineCycles), configModificationDeadlineCycles: BigInt(config.configModificationDeadlineCycles), spenderLimitExecutionMode: config.spenderLimitExecutionMode, withdrawalExecutionMode: config.withdrawalExecutionMode, configModificationExecutionMode: config.configModificationExecutionMode }
    }
  }
  return <div className="governance-overlay"><section className="governance-dialog" role="dialog" aria-modal="true" aria-labelledby="create-proposal-title"><h2 id="create-proposal-title">Create Proposal</h2>
    <form onSubmit={event => { event.preventDefault(); setError(''); try { submit(action()) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } }}>
      <label>Proposal type<select value={kind} onChange={e => { setKind(e.target.value as ProposalKind); setTarget('') }}>{proposalKinds.map(k => <option key={k}>{k}</option>)}</select></label>
      {(kind === 'SetSpenderLimit' || kind === 'EvictMember') && <label>Target member<select required value={target} onChange={e => setTarget(e.target.value)}><option value="">Select member</option>{snapshot.members.filter(m => m.status === 'Active').map(m => <option key={m.address} value={m.address}>{m.wallet} · {m.role}</option>)}</select></label>}
      {kind === 'SetSpenderLimit' && <label>USDC limit per cycle<input required inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>}
      {kind === 'ApproveWithdrawal' && <label>Pending request<select required value={target} onChange={e => setTarget(e.target.value)}><option value="">Select request</option>{snapshot.withdrawals.filter(r => r.status === 'Pending' && r.requiresProposal).map(r => <option key={r.address} value={r.address}>{short(r.address)} · {formatUsdc(r.amount)} → {short(r.recipient)}</option>)}</select></label>}
      {kind === 'AdmitMember' && <><label>Candidate wallet<input required value={candidate} onChange={e => setCandidate(e.target.value)} /></label><label>Inviter wallet<input readOnly value={vouch} /></label></>}
      {kind === 'ConfigurationModification' && Object.entries(config).map(([key,value]) => <label key={key}>{key}{key.endsWith('ExecutionMode') ? <select value={value} onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}><option value="on_deadline">On deadline</option><option value="threshold_met">Threshold met</option></select> : <input required value={value} onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))} />}</label>)}
      {kind === 'ClosePool' && <p>Closure stops new deposits and proposals and enables member refunds. This proposal still requires a vote.</p>}
      <p>New proposals queue for voting starting next cycle. The contract controls approval and execution.</p>
      {(error || transactionError) && <p role="alert">{error || transactionError}</p>}
      {busy && <p role="status">Awaiting wallet approval and chain confirmation…</p>}
      <div className="governance-actions"><button className="primary" disabled={busy}>Submit proposal</button><button type="button" className="outline" disabled={busy} onClick={close}>Cancel</button></div>
    </form>
  </section></div>
}
