import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PoolItem } from './data'
import { fetchOnChainPools, onChainPoolToPoolItem, poolFromAccount, formatUsdc, quorumHealth } from './solana'
import { useWallet } from './wallet'
import { WalletModal } from './WalletModal'
import { NetworkSwitcher } from './NetworkSwitcher'
import { NETWORK_LABELS } from './network'
import { CopilotPanel } from './CopilotPanel'

type View = 'overview' | 'pool'
const Icon = ({ children }: { children: string }) => <span className="icon" aria-hidden="true">{children}</span>

export function App() {
  const wallet = useWallet()
  const [view, setView] = useState<View>('overview')
  const poolSource = `${wallet.network}:${wallet.endpoint}:${wallet.programId}:${wallet.publicKey}`
  const activeSource = useRef(poolSource)
  activeSource.current = poolSource
  const poolRequest = useRef(0)
  const [poolSnapshot, setPoolSnapshot] = useState<{ source: string; pools: PoolItem[] }>({ source: poolSource, pools: [] })
  const onChainPools = poolSnapshot.source === poolSource ? poolSnapshot.pools : []
  const [poolError, setPoolError] = useState<string | null>(null)
  const [loadingPools, setLoadingPools] = useState(false)
  const [selected, setSelected] = useState<PoolItem | null>(null)
  const [menu, setMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [creatingPool, setCreatingPool] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const [copilotOpen, setCopilotOpen] = useState(false)

  const loadOnChainPools = useCallback(async (selectAddress?: string) => {
    const request = ++poolRequest.current
    const isCurrent = () => activeSource.current === poolSource && request === poolRequest.current
    setLoadingPools(true)
    setPoolError(null)
    try {
      if (wallet.useLocalnetApi) {
        // First try the Vite local dev endpoint
        const response = await fetch('/__comfi/mock-wallet/pools')
        if (response.ok) {
          const data = await response.json() as { pools: { address: string; data: string; vaultBalanceAtomic: string }[] }
          if (!Array.isArray(data.pools)) throw new Error('Invalid localnet pools response')
          const items = data.pools.map(p => onChainPoolToPoolItem(poolFromAccount(p.address, p.data, p.vaultBalanceAtomic), wallet.publicKey))
          items.sort((a, b) => a.chain.id - b.chain.id)
          if (!isCurrent()) return []
          setPoolSnapshot({ source: poolSource, pools: items })
          if (selectAddress) {
            const match = items.find(i => i.address === selectAddress)
            if (match) setSelected(match)
          } else {
            setSelected(prev => {
              if (prev) {
                const refreshed = items.find(i => i.id === prev.id)
                return refreshed ?? null
              }
              return prev
            })
          }
          return items
        }
      }
      // Query the selected network directly when the local dev API does not apply.
      const rpc = wallet.endpoint
      const programId = wallet.programId
      if (rpc && programId) {
        const raw = await fetchOnChainPools(rpc, programId)
        const items = raw.map(p => onChainPoolToPoolItem(p, wallet.publicKey))
        if (!isCurrent()) return []
        setPoolSnapshot({ source: poolSource, pools: items })
        if (selectAddress) {
          const match = items.find(i => i.address === selectAddress)
          if (match) setSelected(match)
        } else {
          setSelected(prev => {
            if (prev) {
              const refreshed = items.find(i => i.id === prev.id)
              return refreshed ?? null
            }
            return prev
          })
        }
        return items
      }
    } finally {
      if (isCurrent()) setLoadingPools(false)
    }
    return []
  }, [poolSource, wallet.endpoint, wallet.publicKey, wallet.programId, wallet.useLocalnetApi])

  const refreshPools = useCallback(() => {
    const request = poolRequest.current + 1
    void loadOnChainPools().then(() => {}, error => {
      if (activeSource.current === poolSource && request === poolRequest.current) setPoolError(error instanceof Error ? error.message : String(error))
    })
  }, [loadOnChainPools, poolSource])

  useEffect(() => { refreshPools() }, [refreshPools])
  useEffect(() => { setSelected(null); setView('overview') }, [wallet.network, wallet.endpoint, wallet.programId])

  const goPool = (pool: PoolItem) => { setSelected(pool); setView('pool'); setMenu(false) }

  const closeNotice = () => setNotice('')

  const createPool = async () => {
    if (!wallet.useLocalnetApi) return setNotice('This test action requires the configured localnet RPC.')
    if (!wallet.connected || wallet.walletMode !== 'mock') return setNotice('Select and connect the mock wallet to use this localnet test action.')
    setCreatingPool(true)
    try {
      const response = await fetch('/__comfi/mock-wallet/create-pool', { method: 'POST' })
      const result = await response.json() as { pool?: string; error?: string }
      if (!response.ok || result.error || !result.pool) throw new Error(result.error ?? 'Localnet pool creation failed.')
      setNotice(`Pool deployed on localnet: ${result.pool.slice(0, 4)}…${result.pool.slice(-4)}.`)
      // Refresh on-chain pools and select the newly deployed pool
      await loadOnChainPools(result.pool)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Localnet pool creation failed.')
    } finally {
      setCreatingPool(false)
    }
  }

  const initialize = async () => {
    if (!wallet.useLocalnetApi) return setNotice('This test action requires the configured localnet RPC.')
    if (!wallet.connected || wallet.walletMode !== 'mock') return setNotice('Select and connect the mock wallet to use this localnet test action.')
    setInitializing(true)
    try {
      const response = await fetch('/__comfi/mock-wallet/initialize', { method: 'POST' })
      const result = await response.json() as { global?: string; error?: string }
      if (!response.ok || result.error || !result.global) throw new Error(result.error ?? 'Localnet initialization failed.')
      setNotice(`Localnet deployer initialized: ${result.global.slice(0, 4)}…${result.global.slice(-4)}.`)
      await loadOnChainPools()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Localnet initialization failed.')
    } finally {
      setInitializing(false)
    }
  }

  return <div className="app-shell">
    <aside className={menu ? 'sidebar open' : 'sidebar'}>
      <button className="brand" onClick={() => setView('overview')}><span className="brand-mark">c</span><span>comfi</span></button>
      <nav>
        <button className={view === 'overview' ? 'nav-active' : ''} onClick={() => { setView('overview'); setMenu(false) }}><Icon>⌂</Icon>My pools</button>
        <button data-testid="start-pool" disabled={creatingPool || initializing} onClick={() => { void createPool(); setMenu(false) }}><Icon>＋</Icon>Start a pool</button>
        <button data-testid="side-copilot-btn" onClick={() => { setCopilotOpen(true); setMenu(false) }}><Icon>🤖</Icon>ComFi Copilot</button>
      </nav>
      <div className="side-pools">
        <p>Your spaces</p>
        {onChainPools.map(pool => (
          <button key={pool.id} onClick={() => goPool(pool)} className={selected?.id === pool.id && view === 'pool' ? 'side-selected' : ''}>
            <b className={`pool-glyph ${pool.accent}`}>{pool.icon}</b>
            <span>
              {pool.name}
              {pool.onChain && <small style={{ display: 'block', fontSize: '9px', opacity: 0.7 }}>On-chain · {pool.balance}</small>}
            </span>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom"><span>{wallet.publicKey ? `${wallet.publicKey.slice(0, 4)}…${wallet.publicKey.slice(-4)}` : 'Wallet disconnected'}</span></div>
    </aside>
    <main>
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setMenu(!menu)} aria-label="Open menu">☰</button>
        <div className="crumb">
          {view === 'overview' ? (
            <>
              <span>Community pools</span>
              <strong>{NETWORK_LABELS[wallet.network]}</strong>
            </>
          ) : (
            <button className="back" onClick={() => setView('overview')}>← My pools</button>
          )}
        </div>
        <div className="top-actions">
          <NetworkSwitcher />
          <button
            className="copilot-toggle-btn"
            data-testid="copilot-toggle-btn"
            onClick={() => setCopilotOpen(true)}
            title="Open ComFi Delegated AI Pool Assistant"
          >
            🤖 Copilot
          </button>
          <button
            className="wallet-quick-btn"
            onClick={() => setWalletModalOpen(true)}
            title="Open ComFi Web Wallet (Keypair, Balances, Faucets)"
          >
            ⚡ ComFi Wallet
          </button>
          {wallet.connected ? (
            <button
              className="wallet-status"
              data-testid="wallet-status"
              title={`Click to open ComFi Wallet Manager (${wallet.publicKey})`}
              onClick={() => setWalletModalOpen(true)}
            >
              {wallet.walletLabel} · {wallet.publicKey?.slice(0, 4)}…{wallet.publicKey?.slice(-4)}
            </button>
          ) : (
            <button
              className="primary"
              data-testid="connect-wallet"
              onClick={() => {
                setWalletModalOpen(true)
              }}
            >
              Connect wallet
            </button>
          )}
        </div>
      </header>
      {wallet.connected && (
        <div className="localnet-banner" data-testid="localnet-wallet">
          {wallet.walletMode === 'mock'
            ? `${NETWORK_LABELS[wallet.network]} mock wallet connected`
            : wallet.walletMode === 'phantom'
              ? 'Phantom wallet connected'
              : wallet.walletMode === 'backpack'
                ? 'Backpack wallet connected'
                : 'ComFi In-Browser wallet connected'} · {wallet.endpoint}
        </div>
      )}
      <WalletModal isOpen={walletModalOpen} onClose={() => setWalletModalOpen(false)} />
      <CopilotPanel
        isOpen={copilotOpen}
        onClose={() => setCopilotOpen(false)}
        selectedPool={selected}
        networkName={NETWORK_LABELS[wallet.network]}
        walletConnected={wallet.connected}
        walletAddress={wallet.publicKey}

      />
      {poolError && <div className="pool-error" role="alert">Could not load pools on {NETWORK_LABELS[wallet.network]}: {poolError}</div>}
      {notice && <div className="toast" role="status">{notice}<button onClick={closeNotice}>×</button></div>}
      {view === 'overview' && (
        <Overview
          networkName={NETWORK_LABELS[wallet.network]}
          pools={onChainPools}
          onChainCount={onChainPools.length}
          onRefresh={refreshPools}
          loadingPools={loadingPools}
          onSelect={goPool}
          onInitialize={initialize}
          onStart={createPool}
          creatingPool={creatingPool}
          initializing={initializing}
        />
      )}
      {view === 'pool' && selected && <Pool networkName={NETWORK_LABELS[wallet.network]} pool={selected} />}

    </main>
  </div>
}

function Overview({
  networkName,
  pools,
  onChainCount,
  onRefresh,
  loadingPools,
  onSelect,
  onInitialize,
  onStart,
  creatingPool,
  initializing,
}: {
  networkName: string
  pools: PoolItem[]
  onChainCount: number
  onRefresh: () => void
  loadingPools: boolean
  onSelect: (pool: PoolItem) => void
  onInitialize: () => void
  onStart: () => void
  creatingPool: boolean
  initializing: boolean
}) {
  const totalBalance = useMemo(() => formatUsdc(pools.reduce((sum, pool) => sum + pool.chain.vaultBalanceAtomic, 0n)), [pools])

  return <section className="page overview">
    <div className="hero">
      <div>
        <span className="eyebrow">YOUR COMMUNITY FUNDS</span>
        <h1>Money is clearer<br />when it’s shared.</h1>
        <p>See what your communities are saving, deciding, and spending — all in one calm place.</p>
      </div>
      <div className="localnet-controls">
        <button className="outline localnet-init" data-testid="initialize-localnet" disabled={initializing || creatingPool} onClick={() => void onInitialize()}>
          {initializing ? 'Initializing…' : 'Initialize localnet'}
        </button>
        <button className="primary" data-testid="create-pool" disabled={creatingPool || initializing} onClick={() => void onStart()}>
          {creatingPool ? 'Deploying on localnet…' : <>Start a pool <span>→</span></>}
        </button>
      </div>
    </div>

    <div className="summary-grid">
      <article>
        <span className="summary-icon coral">◒</span>
        <div>
          <small>Across your pools</small>
          <strong>{totalBalance}</strong>
          <em>{onChainCount > 0 ? `${onChainCount} on-chain pool${onChainCount > 1 ? 's' : ''} on ${networkName}` : 'Available for your communities'}</em>
        </div>
      </article>
      <article>
        <span className="summary-icon lime">✓</span>
        <div>
          <small>Pool health</small>
          <strong>{pools.filter(p => p.chain.metrics?.isLocked).length} locked pools</strong>
          <em>{pools.filter(p => p.chain.metrics?.isClosing).length} closing · {pools.filter(p => !p.chain.metrics).length} unavailable</em>
        </div>
      </article>
      <article>
        <span className="summary-icon violet">◌</span>
        <div>
          <small>Governance</small>
          <strong>Proposals not loaded</strong>
          <em>Proposal view is not connected yet</em>
        </div>
      </article>
    </div>

    <div className="section-head">
      <div>
        <h2>Your pools</h2>
        <p>{onChainCount > 0 ? `${onChainCount} verified pool${onChainCount > 1 ? 's' : ''} active on Solana backend` : 'Communities you’re part of'}</p>
      </div>
      <div className="section-tools">
        <button className="refresh-btn" disabled={loadingPools} onClick={onRefresh} title="Query live state from chain backend">
          ↻ {loadingPools ? 'Updating…' : 'Refresh'}
        </button>
      </div>
    </div>

    {pools.length === 0 && <p data-testid="pool-empty-state">{loadingPools ? 'Loading pools…' : `No pools found on ${networkName}. Start a pool or switch networks to find one.`}</p>}
    <div className="pool-grid">
      {pools.map(pool => (
        <button className="pool-card" data-testid={`pool-${pool.id}`} key={pool.id} onClick={() => onSelect(pool)}>
          <div className="pool-card-top">
            <b className={`pool-glyph large ${pool.accent}`}>{pool.icon}</b>
            <div style={{ display: 'flex', gap: '6px' }}>
              {pool.onChain && <span className="tag onchain">On-chain</span>}
              <span className={`tag ${pool.status === 'Contribution due' ? 'warning' : ''}`}>{pool.status}</span>
            </div>
          </div>
          <h3>{pool.name}</h3>
          <p>{pool.role} · {pool.funds} members</p>
          {pool.address && <span className="pda-pill" title={pool.address}>PDA: {pool.address.slice(0, 4)}…{pool.address.slice(-4)}</span>}
          <div className="money">
            <div>
              <small>Pool balance</small>
              <strong>{pool.balance}</strong>
            </div>
            <span>→</span>
          </div>
          <div className="card-foot">
            <span>Cycle renewal <b>{pool.nextDate}</b></span>
            <span>{pool.proposals} proposals created</span>
          </div>
        </button>
      ))}
    </div>
  </section>
}

function Pool({ networkName, pool }: { networkName: string; pool: PoolItem }) {
  return <section className="page pool-page">
    <div className="pool-title">
      <b className={`pool-glyph hero-glyph ${pool.accent}`}>{pool.icon}</b>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="eyebrow">YOUR POOL</span>
          {pool.onChain && <span className="tag onchain">On-chain ({networkName})</span>}
        </div>
        <h1>{pool.name}</h1>
        <p>Cycle {pool.chain.currentCycle.toString()} · {pool.funds} members</p>
        {pool.address && <span className="pda-pill" title={pool.address}>PDA: {pool.address}</span>}
      </div>
    </div>

    <div className="balance-panel">
      <div>
        <p>Vault balance (USDC)</p>
        <strong>{pool.balance}</strong>
        {pool.vault ? <span className="vault-note">Vault: {pool.vault.slice(0, 6)}…{pool.vault.slice(-6)}</span> : <span>Updated a few moments ago</span>}
      </div>
    </div>


    <div className="pool-content">
      <div>
        {pool.onChain && (
          <div style={{ marginBottom: '24px' }}>
            <div className="section-head compact">
              <div>
                <h2>On-chain parameters</h2>
                <p>Enforced autonomously by Anchor smart contract</p>
              </div>
            </div>
            <div className="pool-chain-grid">
              <div className="chain-spec">
                <small>Minimum Deposit</small>
                <strong>{pool.minimumDeposit ?? 'Unavailable'}</strong>
              </div>
              <div className="chain-spec">
                <small>Voting Threshold</small>
                <strong>{pool.voteThreshold} affirmative votes</strong>
              </div>
              <div className="chain-spec">
                <small>Creator wallet</small>
                <strong title={pool.creator}>{pool.creator ? `${pool.creator.slice(0, 6)}…${pool.creator.slice(-6)}` : 'Unavailable'}</strong>
              </div>
              <div className="chain-spec">
                <small>Capacity Limit</small>
                <strong>{pool.cap} members ({pool.slots} slots open)</strong>
              </div>
            </div>
          </div>
        )}

        <PoolMetricsView pool={pool} />
        <div className="section-head compact"><h2>Activity</h2></div>
        <p>Activity history is not connected yet.</p>
      </div>

      <div className="right-rail">
        <div className="action-card">
          <span className="eyebrow">COMMUNITY DECISIONS</span>
          <h3>Have a say in<br />what’s next.</h3>
          <p>{pool.proposals} proposals have been created. Lifecycle status and voting are not connected yet.</p>
        </div>
        <div className="members-card">
          <div className="section-head compact">
            <h3>People</h3>
          </div>
          <p>Member directory is not connected yet.</p>
          <p>{pool.cap - pool.slots} of {pool.cap} places filled · <b>{pool.slots} open places left</b></p>
        </div>
      </div>
    </div>
  </section>
}

function PoolMetricsView({ pool }: { pool: PoolItem }) {
  const metrics = pool.chain.metrics
  if (!metrics) return <p role="status">This pool uses a legacy account layout. Accounting, quorum, and admission metrics are unavailable.</p>
  const health = quorumHealth(metrics, pool.chain.memberCount)
  const spec = (label: string, value: string) => <div className="chain-spec" key={label}><small>{label}</small><strong>{value}</strong></div>
  return <div className="pool-metrics">
    {metrics.isClosing && <p className="pool-warning" role="status">Pool closing. New deposits and proposals are disabled by the contract.</p>}
    {metrics.isLocked && <p className="pool-warning" role="status">Pool locked: quorum was not met at cycle evaluation. Spending and governance actions are restricted.</p>}
    {!metrics.isClosing && !metrics.isLocked && !health.satisfied && <p className="pool-warning" role="status">Funded participation is below the configured quorum. The next cycle evaluation may lock the pool.</p>}
    {!metrics.isClosing && metrics.isLocked && health.cyclesUntilAutoClose !== null && <p className="pool-warning" role="status">Auto-close after {health.cyclesUntilAutoClose.toString()} more consecutive locked cycles.</p>}
    {metrics.rolloverCursor && <p role="status">Cycle rollover is in progress. Member counts may change as rollover completes.</p>}
    <h2>Financial accounting</h2>
    <div className="pool-chain-grid">
      {spec('Vault balance', pool.balance)}
      {spec('Total conferred capital', formatUsdc(metrics.totalConferredCapital))}
      {spec('Non-conferred capital / surplus', formatUsdc(metrics.totalNonConferredCapital))}
      {spec('Escrowed surplus', formatUsdc(metrics.totalEscrowedSurplus))}
      {spec('Settled capital', formatUsdc(metrics.totalSettledCapital))}
      {spec('Member obligation per cycle', formatUsdc(pool.chain.memberObligationAmountAtomic))}
    </div>
    <p>Non-conferred capital includes refundable surplus and unfunded deposits. Conferred capital tracks pool-owned funds. The vault also holds refundable member capital.</p>
    {metrics.hasSnapshottedClosure && <div className="pool-chain-grid">
      {spec('Closure vault basis', formatUsdc(metrics.closingVaultBasis))}
      {spec('Closure non-conferred basis', formatUsdc(metrics.closingNonConferredBasis))}
      {spec('Closure conferred capital', formatUsdc(metrics.closingConferredPoolCapital))}
    </div>}
    <h2>Quorum health</h2>
    <div className="pool-chain-grid">
      {spec('Funded participation', `${metrics.fundedMemberCount} / ${pool.chain.memberCount} (${(health.participationBps / 100).toFixed(2)}%)`)}
      {spec('Matured voting members', metrics.votingMemberCount.toString())}
      {spec('Minimum funded members', metrics.minQuorumMembers.toString())}
      {spec('Minimum participation', `${(metrics.minQuorumBps / 100).toFixed(2)}%`)}
      {spec('Current quorum', health.satisfied ? 'Satisfied' : 'Below minimum')}
      {spec('Lock status', metrics.isLocked ? 'Locked' : 'Unlocked')}
      {spec('Consecutive locked cycles', metrics.lockedConsecutiveCycles.toString())}
      {spec('Auto-close threshold', metrics.autoCloseCyclesThreshold === 0n ? 'Disabled' : `${metrics.autoCloseCyclesThreshold} cycles`)}
    </div>
    <h2>Admission & voting rules</h2>
    <div className="pool-chain-grid">
      {spec('Admission mode', metrics.admissionMode)}
      {spec('Voting maturation', `${metrics.votingMaturationCycles} funded cycles`)}
      {spec('Proposal execution delay', `${metrics.proposalExecutionDelayCycles} cycles`)}
      {spec('Cycle duration', `${pool.chain.cycleDurationSeconds} seconds`)}
      {spec('Voting period', `${pool.chain.votingPeriodSeconds} seconds`)}
      {spec('Execution timelock', `${pool.chain.timelockSeconds} seconds`)}
    </div>
    <p>{metrics.admissionMode === 'InviteVouched' ? 'Admission requires a vouched invitation and governance approval.' : 'Members can join through open admission.'} Voting maturation uses consecutive funded cycles.</p>
    {pool.chain.hasPendingConfig && <p role="status">Configuration changes are pending. The values above are the active rules.</p>}
    {metrics.pendingAdmissionMode !== null && <p>Pending admission mode: {metrics.pendingAdmissionMode}</p>}
    {metrics.pendingVotingMaturationCycles !== null && <p>Pending voting maturation: {metrics.pendingVotingMaturationCycles.toString()} cycles</p>}
    {metrics.pendingProposalExecutionDelayCycles !== null && <p>Pending execution delay: {metrics.pendingProposalExecutionDelayCycles.toString()} cycles</p>}
  </div>
}
