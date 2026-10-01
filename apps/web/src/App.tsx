import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { activity, demoPools, members, type PoolItem } from './data'
import { fetchOnChainPools, onChainPoolToPoolItem } from './solana'
import { useWallet } from './wallet'
import { WalletModal } from './WalletModal'

type View = 'overview' | 'pool' | 'proposal' | 'withdrawal'
type Filter = 'all' | 'onchain' | 'demo'
const Icon = ({ children }: { children: string }) => <span className="icon" aria-hidden="true">{children}</span>

export function App() {
  const wallet = useWallet()
  const [view, setView] = useState<View>('overview')
  const [onChainPools, setOnChainPools] = useState<PoolItem[]>([])
  const [loadingPools, setLoadingPools] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<PoolItem>(demoPools[0])
  const [menu, setMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [creatingPool, setCreatingPool] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const [walletModalOpen, setWalletModalOpen] = useState(false)

  const allPools = useMemo(() => {
    return [...onChainPools, ...demoPools]
  }, [onChainPools])

  const visiblePools = useMemo(() => {
    if (filter === 'onchain') return onChainPools
    if (filter === 'demo') return demoPools
    return allPools
  }, [filter, onChainPools, allPools])

  const loadOnChainPools = useCallback(async (selectAddress?: string) => {
    setLoadingPools(true)
    try {
      // First try the Vite local dev endpoint
      const response = await fetch('/__comfi/mock-wallet/pools')
      if (response.ok) {
        const data = await response.json() as { pools?: any[] }
        if (data.pools && Array.isArray(data.pools)) {
          const items: PoolItem[] = data.pools.map((p: any) => onChainPoolToPoolItem({
            ...p,
            minimumDepositAtomic: BigInt(p.minimumDepositAtomic ?? '0'),
            votingPeriodSeconds: BigInt(p.votingPeriodSeconds ?? '0'),
            timelockSeconds: BigInt(p.timelockSeconds ?? '0'),
            currentCycle: BigInt(p.currentCycle ?? '0'),
            cycleDurationSeconds: BigInt(p.cycleDurationSeconds ?? '0'),
            cycleStartedAt: BigInt(p.cycleStartedAt ?? '0'),
            actionAllowancePerCycle: BigInt(p.actionAllowancePerCycle ?? '0'),
            maxSponsoredActionCharge: BigInt(p.maxSponsoredActionCharge ?? '0'),
            nextRequestId: BigInt(p.nextRequestId ?? '0'),
            nextProposalId: BigInt(p.nextProposalId ?? '0'),
            balanceUsdc: p.balance,
          }, wallet.publicKey))
          setOnChainPools(items)
          if (selectAddress) {
            const match = items.find(i => i.address === selectAddress)
            if (match) setSelected(match)
          } else {
            setSelected(prev => {
              if (prev.onChain) {
                const refreshed = items.find(i => i.id === prev.id)
                return refreshed ?? prev
              }
              return prev
            })
          }
          return items
        }
      }

      // Fallback to direct Solana JSON-RPC
      const rpc = wallet.endpoint
      const programId = import.meta.env.VITE_PROGRAM_ID
      if (rpc && programId) {
        const raw = await fetchOnChainPools(rpc, programId)
        const items = raw.map(p => onChainPoolToPoolItem(p, wallet.publicKey))
        setOnChainPools(items)
        if (selectAddress) {
          const match = items.find(i => i.address === selectAddress)
          if (match) setSelected(match)
        } else {
          setSelected(prev => {
            if (prev.onChain) {
              const refreshed = items.find(i => i.id === prev.id)
              return refreshed ?? prev
            }
            return prev
          })
        }
        return items
      }
    } catch (err) {
      console.warn('Could not load on-chain pools from localnet:', err)
    } finally {
      setLoadingPools(false)
    }
    return []
  }, [wallet.endpoint, wallet.publicKey, selected.onChain])

  useEffect(() => {
    void loadOnChainPools()
  }, [loadOnChainPools])

  const goPool = (pool = selected) => { setSelected(pool); setView('pool'); setMenu(false) }
  const submit = (event: FormEvent, label: string) => { event.preventDefault(); setNotice(`${label} saved for review.`); setView('pool') }
  const closeNotice = () => setNotice('')

  const createPool = async () => {
    if (!wallet.connected) return setNotice('Connect the local mock wallet first.')
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
    if (!wallet.connected) return setNotice('Connect the local mock wallet first.')
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
      </nav>
      <div className="side-pools">
        <p>Your spaces</p>
        {allPools.map(pool => (
          <button key={pool.id} onClick={() => goPool(pool)} className={selected.id === pool.id && view === 'pool' ? 'side-selected' : ''}>
            <b className={`pool-glyph ${pool.accent}`}>{pool.icon}</b>
            <span>
              {pool.name}
              {pool.onChain && <small style={{ display: 'block', fontSize: '9px', opacity: 0.7 }}>On-chain · {pool.balance}</small>}
            </span>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom"><button className="help"><Icon>?</Icon>Help & support</button><button className="profile"><span className="avatar you">YT</span><span><b>Yasmine T.</b><small>Personal settings</small></span><span>›</span></button></div>
    </aside>
    <main>
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setMenu(!menu)} aria-label="Open menu">☰</button>
        <div className="crumb">
          {view === 'overview' ? (
            <>
              <span>Good morning, Yasmine</span>
              <strong>Sunday, July 26</strong>
            </>
          ) : (
            <button className="back" onClick={() => setView('overview')}>← My pools</button>
          )}
        </div>
        <div className="top-actions">
          <button className="bell" onClick={() => setNotice('You’re all caught up.')}>♧<i /></button>
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
              {wallet.walletMode === 'mock' ? 'Mock wallet' : 'ComFi Wallet'} · {wallet.publicKey?.slice(0, 4)}…{wallet.publicKey?.slice(-4)}
            </button>
          ) : (
            <button
              className="primary"
              data-testid="connect-wallet"
              onClick={() => {
                wallet.connect()
                setWalletModalOpen(true)
              }}
            >
              Connect mock wallet
            </button>
          )}
          <button className="avatar you">YT</button>
        </div>
      </header>
      {wallet.connected && (
        <div className="localnet-banner" data-testid="localnet-wallet">
          {wallet.walletMode === 'mock' ? 'Localnet mock wallet connected' : 'ComFi In-Browser wallet connected'} · {wallet.endpoint}
        </div>
      )}
      <WalletModal isOpen={walletModalOpen} onClose={() => setWalletModalOpen(false)} />
      {notice && <div className="toast" role="status">{notice}<button onClick={closeNotice}>×</button></div>}
      {view === 'overview' && (
        <Overview
          pools={visiblePools}
          onChainCount={onChainPools.length}
          filter={filter}
          onFilterChange={setFilter}
          onRefresh={() => void loadOnChainPools()}
          loadingPools={loadingPools}
          onSelect={goPool}
          onInitialize={initialize}
          onStart={createPool}
          creatingPool={creatingPool}
          initializing={initializing}
        />
      )}
      {view === 'pool' && <Pool pool={selected} onProposal={() => setView('proposal')} onWithdrawal={() => setView('withdrawal')} />}
      {view === 'proposal' && <Proposal onCancel={() => setView('pool')} onSubmit={(e) => submit(e, 'Proposal')} />}
      {view === 'withdrawal' && <Withdrawal onCancel={() => setView('pool')} onSubmit={(e) => submit(e, 'Payment request')} />}
    </main>
  </div>
}

function Overview({
  pools,
  onChainCount,
  filter,
  onFilterChange,
  onRefresh,
  loadingPools,
  onSelect,
  onInitialize,
  onStart,
  creatingPool,
  initializing,
}: {
  pools: PoolItem[]
  onChainCount: number
  filter: Filter
  onFilterChange: (f: Filter) => void
  onRefresh: () => void
  loadingPools: boolean
  onSelect: (pool: PoolItem) => void
  onInitialize: () => void
  onStart: () => void
  creatingPool: boolean
  initializing: boolean
}) {
  const totalBalance = useMemo(() => {
    let sum = 0
    for (const p of pools) {
      const parsed = parseFloat(p.balance.replace(/[^0-9.]/g, ''))
      if (!isNaN(parsed)) sum += parsed
    }
    return `$${sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [pools])

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
          <em>{onChainCount > 0 ? `${onChainCount} on-chain pool${onChainCount > 1 ? 's' : ''} on localnet` : 'Available for your communities'}</em>
        </div>
      </article>
      <article>
        <span className="summary-icon lime">✓</span>
        <div>
          <small>Next contribution</small>
          <strong>Cycle renewal</strong>
          <em>Monthly pool distribution</em>
        </div>
      </article>
      <article>
        <span className="summary-icon violet">◌</span>
        <div>
          <small>Needs your input</small>
          <strong>0 open proposals</strong>
          <em>Governance active</em>
        </div>
      </article>
    </div>

    <div className="section-head">
      <div>
        <h2>Your pools</h2>
        <p>{onChainCount > 0 ? `${onChainCount} verified pool${onChainCount > 1 ? 's' : ''} active on Solana backend` : 'Communities you’re part of'}</p>
      </div>
      <div className="section-tools">
        <div className="filter-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => onFilterChange('all')}>All ({pools.length})</button>
          <button className={filter === 'onchain' ? 'active' : ''} onClick={() => onFilterChange('onchain')}>On-chain ({onChainCount})</button>
          <button className={filter === 'demo' ? 'active' : ''} onClick={() => onFilterChange('demo')}>Demo</button>
        </div>
        <button className="refresh-btn" disabled={loadingPools} onClick={onRefresh} title="Query live state from chain backend">
          ↻ {loadingPools ? 'Updating…' : 'Refresh'}
        </button>
      </div>
    </div>

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
          <p>{pool.role} · {pool.funds} contributing</p>
          {pool.address && <span className="pda-pill" title={pool.address}>PDA: {pool.address.slice(0, 4)}…{pool.address.slice(-4)}</span>}
          <div className="money">
            <div>
              <small>Pool balance</small>
              <strong>{pool.balance}</strong>
            </div>
            <span>→</span>
          </div>
          <div className="card-foot">
            <span>Next date <b>{pool.nextDate}</b></span>
            <span>{pool.proposals ? `${pool.proposals} open proposal${pool.proposals > 1 ? 's' : ''}` : 'All caught up'}</span>
          </div>
        </button>
      ))}
    </div>
  </section>
}

function Pool({ pool, onProposal, onWithdrawal }: { pool: PoolItem; onProposal: () => void; onWithdrawal: () => void }) {
  return <section className="page pool-page">
    <div className="pool-title">
      <b className={`pool-glyph hero-glyph ${pool.accent}`}>{pool.icon}</b>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="eyebrow">YOUR POOL</span>
          {pool.onChain && <span className="tag onchain">On-chain (Localnet)</span>}
        </div>
        <h1>{pool.name}</h1>
        <p>Monthly contributions · {pool.funds} members contributing</p>
        {pool.address && <span className="pda-pill" title={pool.address}>PDA: {pool.address}</span>}
      </div>
      <button className="more">•••</button>
    </div>

    <div className="balance-panel">
      <div>
        <p>Available to the community (USDC)</p>
        <strong>{pool.balance}</strong>
        {pool.vault ? <span className="vault-note">Vault: {pool.vault.slice(0, 6)}…{pool.vault.slice(-6)}</span> : <span>Updated a few moments ago</span>}
      </div>
      <div className="balance-actions">
        <button className="outline" onClick={() => {}}>Add money</button>
        <button className="primary" onClick={onWithdrawal}>Request a payment <span>→</span></button>
      </div>
    </div>

    <div className="tabs">
      <button className="tab-active">Overview</button>
      <button>Activity</button>
      <button>People <i>{pool.funds.split(' ')[0]}</i></button>
      <button>Rules</button>
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
                <strong>{pool.minimumDeposit ?? '$10.00'}</strong>
              </div>
              <div className="chain-spec">
                <small>Voting Threshold</small>
                <strong>{pool.voteThreshold ?? 2} affirmative votes</strong>
              </div>
              <div className="chain-spec">
                <small>Creator & Admin</small>
                <strong title={pool.creator}>{pool.creator ? `${pool.creator.slice(0, 6)}…${pool.creator.slice(-6)}` : 'Deployer'}</strong>
              </div>
              <div className="chain-spec">
                <small>Capacity Limit</small>
                <strong>{pool.cap} members ({pool.slots} slots open)</strong>
              </div>
            </div>
          </div>
        )}

        <div className="section-head compact">
          <div>
            <h2>What’s happening</h2>
            <p>Everything is visible to pool members</p>
          </div>
          <button className="text-button">See all <span>→</span></button>
        </div>
        <div className="activity-list">
          {activity.map((item, index) => (
            <div className="activity" key={index}>
              <span className={`avatar ${item.tone}`}>{item.initials}</span>
              <div>
                <p><b>{item.who}</b> {item.action}</p>
                <small>{item.detail} · {item.time}</small>
              </div>
              {item.amount && <strong className={item.tone === 'in' ? 'income' : ''}>{item.amount}</strong>}
            </div>
          ))}
        </div>
        <button className="activity-link">View all activity →</button>
      </div>

      <div className="right-rail">
        <div className="action-card">
          <span className="eyebrow">COMMUNITY DECISIONS</span>
          <h3>Have a say in<br />what’s next.</h3>
          <p>There are {pool.proposals} open proposals waiting for your voice.</p>
          <button className="dark-button" onClick={onProposal}>View proposals <span>→</span></button>
        </div>
        <div className="members-card">
          <div className="section-head compact">
            <h3>People</h3>
            <button className="text-button">See all</button>
          </div>
          <div className="faces">
            {members.map((m, i) => <span className={`avatar face f${i}`} key={m[0]}>{m[0]}</span>)}
            {pool.slots > 0 && <span className="more-faces">+{pool.slots}</span>}
          </div>
          <p>{pool.cap - pool.slots} of {pool.cap} places filled · <b>{pool.slots} open places left</b></p>
        </div>
      </div>
    </div>
  </section>
}

function Proposal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (event: FormEvent) => void }) {
  return <section className="form-page">
    <div className="form-intro">
      <button className="back" onClick={onCancel}>← Back to pool</button>
      <span className="eyebrow">NEW COMMUNITY DECISION</span>
      <h1>Bring an idea<br />to the group.</h1>
      <p>Explain the change clearly. Everyone who is up to date can vote.</p>
      <div className="process">
        <span>1</span><p><b>Create your proposal</b><small>Set out the decision</small></p>
        <span>2</span><p><b>Community votes</b><small>Open for 7 days</small></p>
        <span>3</span><p><b>Put it into action</b><small>After a short pause</small></p>
      </div>
    </div>
    <form className="form-card" onSubmit={onSubmit}>
      <h2>What should change?</h2>
      <label>Proposal type
        <select defaultValue="">
          <option value="" disabled>Choose a change</option>
          <option>Adjust a person’s spending limit</option>
          <option>Change a contribution rule</option>
          <option>Add a community role</option>
          <option>Make room for more members</option>
        </select>
      </label>
      <label>Give your proposal a clear title<input required placeholder="e.g. Increase the garden supply limit" /></label>
      <label>Why does this matter?<textarea required placeholder="Share the context your community needs to decide." rows={4}/></label>
      <div className="form-note">◌ Your proposal will be open for 7 days. It needs 60% support to pass.</div>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit">Continue <span>→</span></button>
      </div>
    </form>
  </section>
}

function Withdrawal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (event: FormEvent) => void }) {
  return <section className="form-page">
    <div className="form-intro">
      <button className="back" onClick={onCancel}>← Back to pool</button>
      <span className="eyebrow">REQUEST A PAYMENT</span>
      <h1>Keep every<br />payment clear.</h1>
      <p>Share who it’s for and why before any money moves.</p>
      <div className="trust-note"><b>Why this step?</b><p>Requests help the community understand spending and keep a shared record.</p></div>
    </div>
    <form className="form-card" onSubmit={onSubmit}>
      <h2>Payment details</h2>
      <div className="two-fields">
        <label>Amount<input required type="number" min="1" step="0.01" placeholder="0.00" /></label>
        <label>For whom?<input required placeholder="Person or organization" /></label>
      </div>
      <label>What is this for?<input required placeholder="e.g. Food pantry supplies" /></label>
      <label>Tell the community more<textarea required placeholder="Add any helpful context." rows={4}/></label>
      <label className="upload">＋ <span><b>Add a receipt or document</b><small>Optional · visible only to your pool</small></span><input type="file" /></label>
      <div className="form-note">◌ This request will be reviewed against the current spending rules.</div>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit">Review request <span>→</span></button>
      </div>
    </form>
  </section>
}
