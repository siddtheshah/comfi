import React, { useEffect, useState, useCallback } from 'react'
import type {
  DevLogEntry,
  MemberInfo,
  PoolInfo,
  ProposalInfo,
  SponsorQuoteResult,
  SystemStatus,
  WithdrawalRequestInfo,
} from './types.js'

export function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [logs, setLogs] = useState<DevLogEntry[]>([])

  // Selected pool
  const [selectedPoolAddress, setSelectedPoolAddress] = useState<string>('')
  const [poolMembers, setPoolMembers] = useState<MemberInfo[]>([])
  const [poolProposals, setPoolProposals] = useState<ProposalInfo[]>([])
  const [poolRequests, setPoolRequests] = useState<WithdrawalRequestInfo[]>([])

  // Action form states
  const [createPoolArgs, setCreatePoolArgs] = useState({
    memberCap: 24,
    minimumDeposit: 10,
    memberObligationAmount: 10,
    initialDeposit: 100,
    enrollmentFee: 1,
    voteThreshold: 2,
    cycleDurationSeconds: 2592000,
    actionAllowancePerCycle: 5,
    maxSponsoredActionCharge: 1,
    testingEnabled: true,
  })

  const [joinPoolArgs, setJoinPoolArgs] = useState({
    walletName: 'member2',
    initialDeposit: 25,
  })

  const [depositArgs, setDepositArgs] = useState({
    walletName: 'creator',
    amount: 50,
  })

  const [aliasArgs, setAliasArgs] = useState({
    walletName: 'creator',
    aliasText: 'Alice',
    encryptionKeyText: 'Key1',
  })

  const [proposalArgs, setProposalArgs] = useState({
    proposerWalletName: 'creator',
    actionKind: 'SetSpenderLimit',
    targetWalletName: 'member2',
    cap: 100,
    requestAddress: '',
    newVoteThreshold: 2,
    newCycleDurationSeconds: 2592000,
    newMemberObligationAmount: 10,
  })

  const [voteArgs, setVoteArgs] = useState({
    proposalAddress: '',
    voterWalletName: 'creator',
    approve: true,
  })

  const [withdrawalArgs, setWithdrawalArgs] = useState({
    requesterWalletName: 'member2',
    recipientAddress: '',
    amount: 10,
    requiresProposal: false,
  })

  const [spendArgs, setSpendArgs] = useState({
    requestAddress: '',
    executorWalletName: 'creator',
    proposalAddress: '',
  })

  const [quoteArgs, setQuoteArgs] = useState({
    action: 'set_alias',
    chargeAtomic: '900',
  })
  const [quoteResult, setQuoteResult] = useState<SponsorQuoteResult | null>(null)

  const addLog = useCallback((type: 'info' | 'success' | 'error', title: string, details?: any) => {
    const entry: DevLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      type,
      title,
      details: details ? (typeof details === 'string' ? details : JSON.stringify(details, null, 2)) : undefined,
    }
    setLogs(prev => [entry, ...prev])
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status')
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data: SystemStatus = await res.json()
      setStatus(data)
      setErrorBanner(null)

      if (data.pools.length > 0 && !selectedPoolAddress) {
        setSelectedPoolAddress(data.pools[0].address)
      }
    } catch (err: any) {
      setErrorBanner(err.message)
      addLog('error', 'Failed to fetch cluster status', err.message)
    }
  }, [selectedPoolAddress, addLog])

  const fetchPoolDetails = useCallback(async (address: string) => {
    if (!address) return
    try {
      const res = await fetch(`/api/pool-details?address=${encodeURIComponent(address)}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setPoolMembers(data.members || [])
      setPoolProposals(data.proposals || [])
      setPoolRequests(data.requests || [])

      if (data.proposals.length > 0 && !voteArgs.proposalAddress) {
        setVoteArgs(prev => ({ ...prev, proposalAddress: data.proposals[0].address }))
      }
      if (data.requests.length > 0 && !spendArgs.requestAddress) {
        setSpendArgs(prev => ({ ...prev, requestAddress: data.requests[0].address }))
      }
    } catch (err: any) {
      addLog('error', `Failed to fetch pool details for ${address.slice(0, 8)}…`, err.message)
    }
  }, [addLog, voteArgs.proposalAddress, spendArgs.requestAddress])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    if (selectedPoolAddress) {
      void fetchPoolDetails(selectedPoolAddress)
    }
  }, [selectedPoolAddress, fetchPoolDetails])

  const runAction = async (action: string, payload: any, actionLabel: string) => {
    setLoading(true)
    setErrorBanner(null)
    addLog('info', `Starting action: ${actionLabel}...`, payload)
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Action execution failed')
      }
      addLog('success', `Success: ${actionLabel}`, data.result)
      await fetchStatus()
      if (selectedPoolAddress) {
        await fetchPoolDetails(selectedPoolAddress)
      }
      return data.result
    } catch (err: any) {
      setErrorBanner(err.message)
      addLog('error', `Failed: ${actionLabel}`, err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }

  const selectedPool = status?.pools.find(p => p.address === selectedPoolAddress)

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* Top Console Header */}
      <header className="console-header">
        <div className="title-group">
          <h1>ComFi Dev Testing Console</h1>
          <span className="meta-tag">Minimalist Dev App</span>
          {status && (
            <>
              <span className="meta-tag">RPC: {status.rpcUrl}</span>
              <span className="meta-tag">Slot: {status.slot}</span>
              <span className="meta-tag">Program: {status.programId.slice(0, 4)}…{status.programId.slice(-4)}</span>
            </>
          )}
        </div>
        <div>
          <button className="refresh-btn" onClick={() => void fetchStatus()} disabled={loading}>
            {loading ? 'Refreshing…' : '⟳ Refresh State'}
          </button>
        </div>
      </header>

      {errorBanner && (
        <div style={{ background: '#da3633', color: '#fff', padding: '8px 12px', borderRadius: '4px', marginBottom: '12px' }}>
          <strong>Error:</strong> {errorBanner}
        </div>
      )}

      {/* Grid of Sections */}
      <div className="dashboard-grid">
        {/* Section 1: Global Config */}
        <div className="panel">
          <div className="panel-header">
            <h2>1. Global Config</h2>
            {status?.global.initialized ? (
              <span className="badge green">INITIALIZED</span>
            ) : (
              <span className="badge red">NOT INITIALIZED</span>
            )}
          </div>
          {status?.global ? (
            <table className="data-table">
              <tbody>
                <tr>
                  <td>Global PDA</td>
                  <td className="mono">{status.global.address}</td>
                </tr>
                <tr>
                  <td>USDC Mint</td>
                  <td className="mono">{status.global.usdcMint || '—'}</td>
                </tr>
                <tr>
                  <td>Treasury</td>
                  <td className="mono">{status.global.treasuryUsdc || '—'}</td>
                </tr>
                <tr>
                  <td>Quote Authority</td>
                  <td className="mono">{status.global.quoteAuthority || '—'}</td>
                </tr>
                <tr>
                  <td>Next Pool ID</td>
                  <td><strong>{status.global.nextPoolId}</strong></td>
                </tr>
                <tr>
                  <td>New Pools Paused</td>
                  <td>
                    {status.global.pausedNewPools ? (
                      <span className="badge red">PAUSED</span>
                    ) : (
                      <span className="badge green">ACTIVE</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>Loading global config…</p>
          )}
          <div className="form-row">
            {!status?.global.initialized ? (
              <button
                className="btn primary"
                disabled={loading}
                onClick={() => void runAction('initialize_global', {}, 'Initialize GlobalConfig')}
              >
                Initialize GlobalConfig
              </button>
            ) : (
              <button
                className="btn small"
                disabled={loading}
                onClick={() => void runAction('toggle_pause_new_pools', {}, 'Toggle Pause New Pools')}
              >
                Toggle Pause New Pools
              </button>
            )}
          </div>
        </div>

        {/* Section 2: Deterministic Wallets */}
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-header">
            <h2>2. Deterministic Localnet Wallets</h2>
            <span className="badge blue">TEST WALLETS</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Public Key</th>
                <th>SOL Balance</th>
                <th>USDC Balance</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {status?.wallets &&
                Object.values(status.wallets).map(w => (
                  <tr key={w.name}>
                    <td><strong>{w.label}</strong></td>
                    <td className="mono" title={w.publicKey}>{w.publicKey.slice(0, 6)}…{w.publicKey.slice(-4)}</td>
                    <td>{w.solBalance}</td>
                    <td><strong>{w.usdcBalance}</strong></td>
                    <td>
                      <div className="form-row">
                        <button
                          className="btn small"
                          disabled={loading}
                          onClick={() => void runAction('fund_wallet', { walletName: w.name, solAmount: 2, usdcAmount: 0 }, `Airdrop SOL to ${w.name}`)}
                        >
                          +2 SOL
                        </button>
                        <button
                          className="btn small primary"
                          disabled={loading || !status.global.initialized}
                          onClick={() => void runAction('fund_wallet', { walletName: w.name, solAmount: 0, usdcAmount: 500 }, `Mint USDC to ${w.name}`)}
                        >
                          +500 USDC
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 3: Pools */}
      <div className="dashboard-grid">
        {/* Pool Creator */}
        <div className="panel">
          <div className="panel-header">
            <h2>3. Create New Pool</h2>
            <span className="badge orange">CREATOR ONLY</span>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Member Cap</label>
              <input
                type="number"
                value={createPoolArgs.memberCap}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, memberCap: parseInt(e.target.value) || 1 })}
                style={{ width: '80px' }}
              />
            </div>
            <div className="form-group">
              <label>Min Deposit ($)</label>
              <input
                type="number"
                value={createPoolArgs.minimumDeposit}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, minimumDeposit: parseFloat(e.target.value) || 0 })}
                style={{ width: '100px' }}
              />
            </div>
            <div className="form-group">
              <label>Member Obligation ($)</label>
              <input
                type="number"
                value={createPoolArgs.memberObligationAmount}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, memberObligationAmount: parseFloat(e.target.value) || 0 })}
                style={{ width: '120px' }}
              />
            </div>
            <div className="form-group">
              <label>Initial Deposit ($)</label>
              <input
                type="number"
                value={createPoolArgs.initialDeposit}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, initialDeposit: parseFloat(e.target.value) || 0 })}
                style={{ width: '110px' }}
              />
            </div>
            <div className="form-group">
              <label>Enroll Fee ($)</label>
              <input
                type="number"
                value={createPoolArgs.enrollmentFee}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, enrollmentFee: parseFloat(e.target.value) || 0 })}
                style={{ width: '90px' }}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Vote Threshold</label>
              <input
                type="number"
                value={createPoolArgs.voteThreshold}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, voteThreshold: parseInt(e.target.value) || 1 })}
                style={{ width: '90px' }}
              />
            </div>
            <div className="form-group">
              <label>Cycle Duration (s)</label>
              <input
                type="number"
                value={createPoolArgs.cycleDurationSeconds}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, cycleDurationSeconds: parseInt(e.target.value) || 60 })}
                style={{ width: '120px' }}
              />
            </div>
            <div className="form-group">
              <label>Action Allowance ($)</label>
              <input
                type="number"
                value={createPoolArgs.actionAllowancePerCycle}
                onChange={e => setCreatePoolArgs({ ...createPoolArgs, actionAllowancePerCycle: parseFloat(e.target.value) || 0 })}
                style={{ width: '120px' }}
              />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingTop: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px' }}>
                <input
                  type="checkbox"
                  checked={createPoolArgs.testingEnabled}
                  onChange={e => setCreatePoolArgs({ ...createPoolArgs, testingEnabled: e.target.checked })}
                />
                Testing Enabled
              </label>
            </div>
          </div>
          <button
            className="btn primary"
            disabled={loading || !status?.global.initialized || status?.global.pausedNewPools}
            onClick={() => void runAction('create_pool', createPoolArgs, 'Create Pool')}
          >
            Create Pool on Localnet
          </button>
        </div>

        {/* Pool Selector & Inspector */}
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-header">
            <h2>4. On-Chain Pools ({status?.pools.length || 0})</h2>
            <div className="form-row">
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Selected Pool:</label>
              <select
                value={selectedPoolAddress}
                onChange={e => setSelectedPoolAddress(e.target.value)}
              >
                {status?.pools.map(p => (
                  <option key={p.address} value={p.address}>
                    Pool #{p.id} ({p.address.slice(0, 6)}…{p.address.slice(-4)}) - {p.vaultUsdcBalance}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedPool ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <table className="data-table">
                  <tbody>
                    <tr>
                      <td>Address</td>
                      <td className="mono">{selectedPool.address}</td>
                    </tr>
                    <tr>
                      <td>Vault Address</td>
                      <td className="mono">{selectedPool.vault}</td>
                    </tr>
                    <tr>
                      <td>Vault USDC Balance</td>
                      <td><strong style={{ color: '#3fb950' }}>{selectedPool.vaultUsdcBalance}</strong></td>
                    </tr>
                    <tr>
                      <td>Members</td>
                      <td>{selectedPool.memberCount} / {selectedPool.memberCap}</td>
                    </tr>
                    <tr>
                      <td>Min Deposit</td>
                      <td>{selectedPool.minimumDeposit}</td>
                    </tr>
                    <tr>
                      <td>Member Obligation</td>
                      <td><strong style={{ color: '#58a6ff' }}>{selectedPool.memberObligationAmount}</strong></td>
                    </tr>
                  </tbody>
                </table>

                <table className="data-table">
                  <tbody>
                    <tr>
                      <td>Vote Threshold</td>
                      <td>{selectedPool.voteThreshold} votes</td>
                    </tr>
                    <tr>
                      <td>Cycle Duration</td>
                      <td>{selectedPool.cycleDurationSeconds}s</td>
                    </tr>
                    <tr>
                      <td>Current Cycle</td>
                      <td><strong>Cycle {selectedPool.currentCycle}</strong></td>
                    </tr>
                    <tr>
                      <td>Cycle Started At</td>
                      <td>{new Date(selectedPool.cycleStartedAt * 1000).toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Next Request ID</td>
                      <td>{selectedPool.nextRequestId}</td>
                    </tr>
                    <tr>
                      <td>Next Proposal ID</td>
                      <td>{selectedPool.nextProposalId}</td>
                    </tr>
                    <tr>
                      <td>Testing Mode</td>
                      <td>
                        <span className={selectedPool.testingEnabled ? 'badge green' : 'badge red'}>
                          {selectedPool.testingEnabled ? '✓ Enabled (Bypass Allowed)' : '✗ Disabled'}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {selectedPool.hasPendingConfig && (
                <div style={{ background: 'rgba(56, 139, 253, 0.15)', border: '1px solid #388bfd', borderRadius: '6px', padding: '10px 14px', marginTop: '10px', fontSize: '13px' }}>
                  <strong style={{ color: '#58a6ff' }}>⏳ Pending Configuration Modification (Applies Next Cycle):</strong>
                  <div style={{ marginTop: '4px', color: '#c9d1d9' }}>
                    Vote Threshold: <strong>{selectedPool.pendingVoteThreshold} votes</strong> &bull; Cycle Duration: <strong>{selectedPool.pendingCycleDurationSeconds}s</strong> &bull; Member Obligation: <strong>{selectedPool.pendingMemberObligationAmount}</strong>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>No pool selected or no pools deployed.</p>
          )}

          {selectedPool && (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="form-row" style={{ alignItems: 'center' }}>
                <button
                  className="btn small"
                  disabled={loading}
                  onClick={() => void runAction('roll_cycle', { poolAddress: selectedPool.address }, `Roll Cycle for Pool #${selectedPool.id}`)}
                >
                  Roll Cycle
                </button>
                <button
                  className="btn small primary"
                  disabled={loading}
                  title="Force rolls the cycle forward immediately (requires testing enabled)"
                  onClick={() => void runAction('test_roll_cycle', { poolAddress: selectedPool.address }, `Test Roll Cycle for Pool #${selectedPool.id}`)}
                >
                  ⚡ Test Roll Cycle
                </button>
              </div>
              <div className="form-row" style={{ alignItems: 'center' }}>
                <input
                  type="number"
                  min="1"
                  defaultValue="1"
                  id="advance-cycles-input"
                  style={{ width: '60px', padding: '4px 6px', fontSize: '12px' }}
                />
                <button
                  className="btn small"
                  disabled={loading}
                  onClick={() => {
                    const input = document.getElementById('advance-cycles-input') as HTMLInputElement
                    const count = parseInt(input?.value || '1', 10)
                    void runAction('test_advance_cycles', { poolAddress: selectedPool.address, count }, `Advance ${count} Cycles`)
                  }}
                >
                  Advance Cycles
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 4: Members & Actions */}
      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-header">
            <h2>5. Member Operations (Pool #{selectedPool?.id ?? '?'})</h2>
          </div>

          {/* Join Pool Form */}
          <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
            <h4 style={{ marginBottom: '6px', fontSize: '12px' }}>Join Pool</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Wallet</label>
                <select
                  value={joinPoolArgs.walletName}
                  onChange={e => setJoinPoolArgs({ ...joinPoolArgs, walletName: e.target.value })}
                >
                  <option value="member2">Member 2</option>
                  <option value="creator">Demo Creator</option>
                  <option value="administrator">Administrator</option>
                </select>
              </div>
              <div className="form-group">
                <label>Deposit ($)</label>
                <input
                  type="number"
                  value={joinPoolArgs.initialDeposit}
                  onChange={e => setJoinPoolArgs({ ...joinPoolArgs, initialDeposit: parseFloat(e.target.value) || 0 })}
                  style={{ width: '80px' }}
                />
              </div>
              <button
                className="btn primary small"
                disabled={loading || !selectedPoolAddress}
                style={{ marginTop: '16px' }}
                onClick={() =>
                  void runAction(
                    'join_pool',
                    { poolAddress: selectedPoolAddress, walletName: joinPoolArgs.walletName, initialDeposit: joinPoolArgs.initialDeposit },
                    `Join Pool as ${joinPoolArgs.walletName}`
                  )
                }
              >
                Join Pool
              </button>
            </div>
          </div>

          {/* Deposit Form */}
          <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
            <h4 style={{ marginBottom: '6px', fontSize: '12px' }}>Deposit to Vault</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Wallet</label>
                <select
                  value={depositArgs.walletName}
                  onChange={e => setDepositArgs({ ...depositArgs, walletName: e.target.value })}
                >
                  <option value="creator">Demo Creator</option>
                  <option value="member2">Member 2</option>
                </select>
              </div>
              <div className="form-group">
                <label>Amount ($)</label>
                <input
                  type="number"
                  value={depositArgs.amount}
                  onChange={e => setDepositArgs({ ...depositArgs, amount: parseFloat(e.target.value) || 0 })}
                  style={{ width: '80px' }}
                />
              </div>
              <button
                className="btn small"
                disabled={loading || !selectedPoolAddress}
                style={{ marginTop: '16px' }}
                onClick={() =>
                  void runAction(
                    'deposit',
                    { poolAddress: selectedPoolAddress, walletName: depositArgs.walletName, amount: depositArgs.amount },
                    `Deposit $${depositArgs.amount} from ${depositArgs.walletName}`
                  )
                }
              >
                Deposit
              </button>
            </div>
          </div>

          {/* Set Alias Form */}
          <div>
            <h4 style={{ marginBottom: '6px', fontSize: '12px' }}>Set Alias</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Wallet</label>
                <select
                  value={aliasArgs.walletName}
                  onChange={e => setAliasArgs({ ...aliasArgs, walletName: e.target.value })}
                >
                  <option value="creator">Demo Creator</option>
                  <option value="member2">Member 2</option>
                </select>
              </div>
              <div className="form-group">
                <label>Alias</label>
                <input
                  type="text"
                  value={aliasArgs.aliasText}
                  onChange={e => setAliasArgs({ ...aliasArgs, aliasText: e.target.value })}
                  style={{ width: '80px' }}
                />
              </div>
              <button
                className="btn small"
                disabled={loading || !selectedPoolAddress}
                style={{ marginTop: '16px' }}
                onClick={() =>
                  void runAction(
                    'set_alias',
                    { poolAddress: selectedPoolAddress, walletName: aliasArgs.walletName, aliasText: aliasArgs.aliasText },
                    `Set Alias "${aliasArgs.aliasText}" for ${aliasArgs.walletName}`
                  )
                }
              >
                Set Alias
              </button>
            </div>
          </div>
        </div>

        {/* Members List Table */}
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-header">
            <h2>Pool Members ({poolMembers.length})</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Role</th>
                <th>Spend Limit</th>
                <th>Funded</th>
                <th>Deposited</th>
                <th>Alias Ver</th>
                <th>Allowance Used</th>
              </tr>
            </thead>
            <tbody>
              {poolMembers.length > 0 ? (
                poolMembers.map(m => (
                  <tr key={m.address}>
                    <td className="mono" title={m.wallet}>{m.wallet.slice(0, 6)}…{m.wallet.slice(-4)}</td>
                    <td>
                      {m.role === 'Admin' ? (
                        <span className="badge orange">Admin</span>
                      ) : m.role === 'Spender' ? (
                        <span className="badge green">Spender</span>
                      ) : (
                        <span className="badge blue">Member</span>
                      )}
                    </td>
                    <td><strong>{m.spendLimit ?? '$0.00'}</strong></td>
                    <td>{m.isFunded ? <span className="badge green">YES</span> : <span className="badge red">NO</span>}</td>
                    <td>{m.depositedTotal}</td>
                    <td>v{m.aliasVersion}</td>
                    <td>{m.actionAllowanceUsed}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No members found for this pool.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 5: Governance & Proposals */}
      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-header">
            <h2>6. Create Proposal</h2>
          </div>
          <div className="form-group">
            <label>Proposer Wallet</label>
            <select
              value={proposalArgs.proposerWalletName}
              onChange={e => setProposalArgs({ ...proposalArgs, proposerWalletName: e.target.value })}
            >
              <option value="creator">Demo Creator</option>
              <option value="member2">Member 2</option>
            </select>
          </div>
          <div className="form-group">
            <label>Action Type</label>
            <select
              value={proposalArgs.actionKind}
              onChange={e => setProposalArgs({ ...proposalArgs, actionKind: e.target.value })}
            >
              <option value="SetSpenderLimit">Set Spender Limit</option>
              <option value="ApproveWithdrawal">Approve Withdrawal</option>
              <option value="ConfigurationModification">Configuration Modification</option>
            </select>
          </div>

          {proposalArgs.actionKind === 'SetSpenderLimit' ? (
            <div className="form-row">
              <div className="form-group">
                <label>Target Member</label>
                <select
                  value={proposalArgs.targetWalletName}
                  onChange={e => setProposalArgs({ ...proposalArgs, targetWalletName: e.target.value })}
                >
                  <option value="member2">Member 2</option>
                  <option value="creator">Demo Creator</option>
                </select>
              </div>
              <div className="form-group">
                <label>Cap ($)</label>
                <input
                  type="number"
                  value={proposalArgs.cap}
                  onChange={e => setProposalArgs({ ...proposalArgs, cap: parseFloat(e.target.value) || 0 })}
                  style={{ width: '90px' }}
                />
              </div>
            </div>
          ) : proposalArgs.actionKind === 'ApproveWithdrawal' ? (
            <div className="form-group">
              <label>Request Address</label>
              <select
                value={proposalArgs.requestAddress}
                onChange={e => setProposalArgs({ ...proposalArgs, requestAddress: e.target.value })}
              >
                <option value="">Select Request…</option>
                {poolRequests.map(r => (
                  <option key={r.address} value={r.address}>
                    Request #{r.id} ({r.amount})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="form-row">
              <div className="form-group">
                <label>New Vote Threshold</label>
                <input
                  type="number"
                  value={proposalArgs.newVoteThreshold}
                  onChange={e => setProposalArgs({ ...proposalArgs, newVoteThreshold: parseInt(e.target.value) || 1 })}
                  style={{ width: '90px' }}
                />
              </div>
              <div className="form-group">
                <label>New Cycle (s)</label>
                <input
                  type="number"
                  value={proposalArgs.newCycleDurationSeconds}
                  onChange={e => setProposalArgs({ ...proposalArgs, newCycleDurationSeconds: parseInt(e.target.value) || 60 })}
                  style={{ width: '100px' }}
                />
              </div>
              <div className="form-group">
                <label>New Obligation ($)</label>
                <input
                  type="number"
                  value={proposalArgs.newMemberObligationAmount}
                  onChange={e => setProposalArgs({ ...proposalArgs, newMemberObligationAmount: parseFloat(e.target.value) || 0 })}
                  style={{ width: '110px' }}
                />
              </div>
            </div>
          )}

          <button
            className="btn primary"
            disabled={loading || !selectedPoolAddress}
            onClick={() =>
              void runAction(
                'create_proposal',
                {
                  poolAddress: selectedPoolAddress,
                  proposerWalletName: proposalArgs.proposerWalletName,
                  actionKind: proposalArgs.actionKind,
                  targetWalletName: proposalArgs.targetWalletName,
                  cap: proposalArgs.cap,
                  requestAddress: proposalArgs.requestAddress,
                  voteThreshold: proposalArgs.newVoteThreshold,
                  cycleDurationSeconds: proposalArgs.newCycleDurationSeconds,
                  memberObligationAmount: proposalArgs.newMemberObligationAmount,
                },
                `Create Proposal (${proposalArgs.actionKind})`
              )
            }
          >
            Create Proposal
          </button>
        </div>

        {/* Proposals List & Voting */}
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-header">
            <h2>Proposals ({poolProposals.length})</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Details</th>
                <th>Votes (Yes / No)</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {poolProposals.length > 0 ? (
                poolProposals.map(p => (
                  <tr key={p.address}>
                    <td>#{p.id}</td>
                    <td><strong>{p.actionType}</strong></td>
                    <td style={{ fontSize: '11px' }}>{p.actionDetails}</td>
                    <td>
                      <span style={{ color: '#3fb950' }}>{p.yesVotes} Y</span> / <span style={{ color: '#f85149' }}>{p.noVotes} N</span>
                    </td>
                    <td>
                      {p.state === 'Queued' && <span className="badge purple" title={`Enqueued to be votable in cycle ${p.votingCycle}`}>Enqueued (Cycle {p.votingCycle})</span>}
                      {p.state === 'Open' && <span className="badge blue">Open</span>}
                      {p.state === 'Executable' && <span className="badge green">Executable</span>}
                      {p.state === 'Executed' && <span className="badge orange">Executed</span>}
                      {p.state === 'Rejected' && <span className="badge red">Rejected</span>}
                    </td>
                    <td>
                      <div className="form-row">
                        {p.state === 'Queued' && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', marginRight: '8px' }}>
                            Opens for vote in Cycle {p.votingCycle}
                          </span>
                        )}
                        {p.state === 'Open' && (
                          <>
                            <button
                              className="btn small primary"
                              disabled={loading}
                              onClick={() =>
                                void runAction(
                                  'vote',
                                  { proposalAddress: p.address, voterWalletName: 'creator', approve: true },
                                  `Vote Yes on #${p.id} as Creator`
                                )
                              }
                            >
                              Vote Yes (Creator)
                            </button>
                            <button
                              className="btn small"
                              disabled={loading}
                              onClick={() =>
                                void runAction(
                                  'vote',
                                  { proposalAddress: p.address, voterWalletName: 'member2', approve: true },
                                  `Vote Yes on #${p.id} as Member2`
                                )
                              }
                            >
                              Vote Yes (M2)
                            </button>
                            <button
                              className="btn small"
                              disabled={loading}
                              onClick={() =>
                                void runAction(
                                  'finalize_proposal',
                                  { proposalAddress: p.address },
                                  `Finalize Proposal #${p.id}`
                                )
                              }
                            >
                              Finalize
                            </button>
                            <button
                              className="btn small"
                              style={{ borderColor: 'var(--accent)' }}
                              disabled={loading}
                              title="Test Finalize (Bypasses voting deadline and timelock)"
                              onClick={() =>
                                void runAction(
                                  'test_finalize_proposal',
                                  { poolAddress: selectedPool?.address, proposalAddress: p.address },
                                  `Test Finalize Proposal #${p.id} (Dev Bypass)`
                                )
                              }
                            >
                              ⚡ Test Finalize
                            </button>
                          </>
                        )}
                        {p.state === 'Executable' && p.actionType === 'SetSpenderLimit' && (
                          <button
                            className="btn small primary"
                            disabled={loading}
                            onClick={() =>
                              void runAction(
                                'execute_spender_limit',
                                { proposalAddress: p.address, executorWalletName: 'creator' },
                                `Execute Spender Limit for #${p.id}`
                              )
                            }
                          >
                            Execute Spender Limit
                          </button>
                        )}
                        {p.state === 'Executable' && p.actionType === 'ConfigurationModification' && (
                          <button
                            className="btn small primary"
                            disabled={loading}
                            onClick={() =>
                              void runAction(
                                'execute_configuration_modification',
                                { proposalAddress: p.address, executorWalletName: 'creator' },
                                `Execute Configuration Modification for #${p.id}`
                              )
                            }
                          >
                            Execute Config Modification
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No proposals for this pool.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 6: Withdrawals & Spend */}
      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-header">
            <h2>7. Request Withdrawal</h2>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Requester</label>
              <select
                value={withdrawalArgs.requesterWalletName}
                onChange={e => setWithdrawalArgs({ ...withdrawalArgs, requesterWalletName: e.target.value })}
              >
                <option value="member2">Member 2</option>
                <option value="creator">Demo Creator</option>
              </select>
            </div>
            <div className="form-group">
              <label>Amount ($)</label>
              <input
                type="number"
                value={withdrawalArgs.amount}
                onChange={e => setWithdrawalArgs({ ...withdrawalArgs, amount: parseFloat(e.target.value) || 0 })}
                style={{ width: '90px' }}
              />
            </div>
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="checkbox"
                checked={withdrawalArgs.requiresProposal}
                onChange={e => setWithdrawalArgs({ ...withdrawalArgs, requiresProposal: e.target.checked })}
              />
              Requires Proposal Approval
            </label>
          </div>
          <button
            className="btn primary"
            disabled={loading || !selectedPoolAddress}
            onClick={() =>
              void runAction(
                'request_withdrawal',
                {
                  poolAddress: selectedPoolAddress,
                  requesterWalletName: withdrawalArgs.requesterWalletName,
                  amount: withdrawalArgs.amount,
                  requiresProposal: withdrawalArgs.requiresProposal,
                },
                `Request Withdrawal of $${withdrawalArgs.amount}`
              )
            }
          >
            Submit Request
          </button>
        </div>

        {/* Requests Table & Spend Execution */}
        <div className="panel" style={{ gridColumn: 'span 2' }}>
          <div className="panel-header">
            <h2>Withdrawal Requests ({poolRequests.length})</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Requester</th>
                <th>Amount</th>
                <th>Requires Prop</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {poolRequests.length > 0 ? (
                poolRequests.map(r => (
                  <tr key={r.address}>
                    <td>#{r.id}</td>
                    <td className="mono">{r.requester.slice(0, 6)}…{r.requester.slice(-4)}</td>
                    <td><strong>{r.amount}</strong></td>
                    <td>{r.requiresProposal ? <span className="badge orange">YES</span> : <span className="badge blue">NO</span>}</td>
                    <td>
                      {r.status === 'Pending' && <span className="badge blue">Pending</span>}
                      {r.status === 'Spent' && <span className="badge green">Spent</span>}
                      {r.status === 'Cancelled' && <span className="badge red">Cancelled</span>}
                    </td>
                    <td>
                      {r.status === 'Pending' && (
                        <button
                          className="btn small primary"
                          disabled={loading}
                          onClick={() =>
                            void runAction(
                              'spend',
                              {
                                requestAddress: r.address,
                                executorWalletName: 'creator',
                                proposalAddress: spendArgs.proposalAddress || null,
                              },
                              `Execute Spend for Request #${r.id}`
                            )
                          }
                        >
                          Execute Spend
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No withdrawal requests for this pool.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 7: Sponsor API */}
      <div className="dashboard-grid">
        <div className="panel" style={{ gridColumn: 'span 3' }}>
          <div className="panel-header">
            <h2>8. Sponsor API Service Quote Verification (@comfi/sponsor-api)</h2>
            <span className="badge blue">SERVICE INTEGRATION</span>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Action</label>
              <select
                value={quoteArgs.action}
                onChange={e => setQuoteArgs({ ...quoteArgs, action: e.target.value })}
              >
                <option value="set_alias">set_alias</option>
              </select>
            </div>
            <div className="form-group">
              <label>Charge Atomic</label>
              <input
                type="text"
                value={quoteArgs.chargeAtomic}
                onChange={e => setQuoteArgs({ ...quoteArgs, chargeAtomic: e.target.value })}
                style={{ width: '120px' }}
              />
            </div>
            <button
              className="btn primary small"
              disabled={loading || !selectedPoolAddress || poolMembers.length === 0}
              style={{ marginTop: '16px' }}
              onClick={async () => {
                if (!poolMembers[0]) return
                const res = await runAction(
                  'sponsor_quote',
                  {
                    poolAddress: selectedPoolAddress,
                    memberAddress: poolMembers[0].address,
                    action: quoteArgs.action,
                    chargeAtomic: quoteArgs.chargeAtomic,
                  },
                  'Issue & Verify Sponsor Action Quote'
                )
                setQuoteResult(res)
              }}
            >
              Issue & Verify Quote
            </button>
          </div>

          {quoteResult && (
            <div style={{ marginTop: '10px', background: 'var(--surface-alt)', padding: '10px', borderRadius: '4px' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '6px' }}>
                <strong>Quote ID:</strong> <span className="mono">{quoteResult.quoteId}</span>
                <strong>Charge:</strong> <span>{quoteResult.chargeUsdc}</span>
                <strong>Expires:</strong> <span>{quoteResult.expiresAt}</span>
                <strong>Verified:</strong>{' '}
                {quoteResult.verified ? <span className="badge green">SIGNATURE VALID</span> : <span className="badge red">INVALID</span>}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                <strong>Signature:</strong> <span className="mono">{quoteResult.signature}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Section: Dev Action & Transaction Log */}
      <div className="log-panel">
        <div className="log-controls">
          <h2>9. Dev Execution & Transaction Log</h2>
          <button className="btn small" onClick={() => setLogs([])}>
            Clear Logs
          </button>
        </div>
        <div className="log-container">
          {logs.length > 0 ? (
            logs.map(log => (
              <div key={log.id} className={`log-entry ${log.type}`}>
                <span className="time">[{log.time}]</span>
                <span className="msg">
                  <strong>{log.title}</strong>
                  {log.details && <pre>{log.details}</pre>}
                </span>
              </div>
            ))
          ) : (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No actions executed yet. Click any button above to run instructions and view live feedback.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
