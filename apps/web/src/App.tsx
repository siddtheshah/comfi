import { FormEvent, useState } from 'react'
import { activity, members, pools } from './data'

type View = 'overview' | 'pool' | 'proposal' | 'withdrawal'
const Icon = ({ children }: { children: string }) => <span className="icon" aria-hidden="true">{children}</span>

export function App() {
  const [view, setView] = useState<View>('overview')
  const [selected, setSelected] = useState(pools[0])
  const [menu, setMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const goPool = (pool = selected) => { setSelected(pool); setView('pool'); setMenu(false) }
  const submit = (event: FormEvent, label: string) => { event.preventDefault(); setNotice(`${label} saved for review.`); setView('pool') }
  const closeNotice = () => setNotice('')

  return <div className="app-shell">
    <aside className={menu ? 'sidebar open' : 'sidebar'}>
      <button className="brand" onClick={() => setView('overview')}><span className="brand-mark">c</span><span>comfi</span></button>
      <nav>
        <button className={view === 'overview' ? 'nav-active' : ''} onClick={() => { setView('overview'); setMenu(false) }}><Icon>⌂</Icon>My pools</button>
        <button onClick={() => { setNotice('Creating a pool will be available when setup is connected.'); setMenu(false) }}><Icon>＋</Icon>Start a pool</button>
      </nav>
      <div className="side-pools"><p>Your spaces</p>{pools.map(pool => <button key={pool.id} onClick={() => goPool(pool)} className={selected.id === pool.id && view === 'pool' ? 'side-selected' : ''}><b className={`pool-glyph ${pool.accent}`}>{pool.icon}</b>{pool.name}</button>)}</div>
      <div className="sidebar-bottom"><button className="help"><Icon>?</Icon>Help & support</button><button className="profile"><span className="avatar you">YT</span><span><b>Yasmine T.</b><small>Personal settings</small></span><span>›</span></button></div>
    </aside>
    <main>
      <header className="topbar"><button className="mobile-menu" onClick={() => setMenu(!menu)} aria-label="Open menu">☰</button><div className="crumb">{view === 'overview' ? <><span>Good morning, Yasmine</span><strong>Sunday, July 26</strong></> : <button className="back" onClick={() => setView('overview')}>← My pools</button>}</div><div className="top-actions"><button className="bell" onClick={() => setNotice('You’re all caught up.')}>♧<i /></button><button className="avatar you">YT</button></div></header>
      {notice && <div className="toast" role="status">{notice}<button onClick={closeNotice}>×</button></div>}
      {view === 'overview' && <Overview onSelect={goPool} onStart={() => setNotice('Creating a pool will be available when setup is connected.')} />}
      {view === 'pool' && <Pool pool={selected} onProposal={() => setView('proposal')} onWithdrawal={() => setView('withdrawal')} />}
      {view === 'proposal' && <Proposal onCancel={() => setView('pool')} onSubmit={(e) => submit(e, 'Proposal')} />}
      {view === 'withdrawal' && <Withdrawal onCancel={() => setView('pool')} onSubmit={(e) => submit(e, 'Payment request')} />}
    </main>
  </div>
}

function Overview({ onSelect, onStart }: { onSelect: (pool: typeof pools[0]) => void; onStart: () => void }) {
 return <section className="page overview"><div className="hero"><div><span className="eyebrow">YOUR COMMUNITY FUNDS</span><h1>Money is clearer<br />when it’s shared.</h1><p>See what your communities are saving, deciding, and spending — all in one calm place.</p></div><button className="primary" onClick={onStart}>Start a pool <span>→</span></button></div>
 <div className="summary-grid"><article><span className="summary-icon coral">◒</span><div><small>Across your pools</small><strong>$7,026.00</strong><em>Available for your communities</em></div></article><article><span className="summary-icon lime">✓</span><div><small>Next contribution</small><strong>Today</strong><em>Room 204 Family Fund · $20</em></div></article><article><span className="summary-icon violet">◌</span><div><small>Needs your input</small><strong>2 proposals</strong><em>One closes in 2 days</em></div></article></div>
 <div className="section-head"><div><h2>Your pools</h2><p>Communities you’re part of</p></div><button className="text-button">View activity <span>→</span></button></div><div className="pool-grid">{pools.map(pool => <button className="pool-card" key={pool.id} onClick={() => onSelect(pool)}><div className="pool-card-top"><b className={`pool-glyph large ${pool.accent}`}>{pool.icon}</b><span className={`tag ${pool.status === 'Contribution due' ? 'warning' : ''}`}>{pool.status}</span></div><h3>{pool.name}</h3><p>{pool.role} · {pool.funds} contributing</p><div className="money"><div><small>Pool balance</small><strong>{pool.balance}</strong></div><span>→</span></div><div className="card-foot"><span>Next date <b>{pool.nextDate}</b></span><span>{pool.proposals ? `${pool.proposals} open proposal${pool.proposals > 1 ? 's' : ''}` : 'All caught up'}</span></div></button>)}</div></section>
}

function Pool({ pool, onProposal, onWithdrawal }: { pool: typeof pools[0]; onProposal: () => void; onWithdrawal: () => void }) {
 return <section className="page pool-page"><div className="pool-title"><b className={`pool-glyph hero-glyph ${pool.accent}`}>{pool.icon}</b><div><span className="eyebrow">YOUR POOL</span><h1>{pool.name}</h1><p>Monthly contributions · {pool.funds} members contributing</p></div><button className="more">•••</button></div>
 <div className="balance-panel"><div><p>Available to the community</p><strong>{pool.balance}</strong><span>Updated a few moments ago</span></div><div className="balance-actions"><button className="outline" onClick={() => {}}>Add money</button><button className="primary" onClick={onWithdrawal}>Request a payment <span>→</span></button></div></div>
 <div className="tabs"><button className="tab-active">Overview</button><button>Activity</button><button>People <i>18</i></button><button>Rules</button></div>
 <div className="pool-content"><div><div className="section-head compact"><div><h2>What’s happening</h2><p>Everything is visible to pool members</p></div><button className="text-button">See all <span>→</span></button></div><div className="activity-list">{activity.map((item, index) => <div className="activity" key={index}><span className={`avatar ${item.tone}`}>{item.initials}</span><div><p><b>{item.who}</b> {item.action}</p><small>{item.detail} · {item.time}</small></div>{item.amount && <strong className={item.tone === 'in' ? 'income' : ''}>{item.amount}</strong>}</div>)}</div><button className="activity-link">View all activity →</button></div><div className="right-rail"><div className="action-card"><span className="eyebrow">COMMUNITY DECISIONS</span><h3>Have a say in<br />what’s next.</h3><p>There are {pool.proposals} open proposals waiting for your voice.</p><button className="dark-button" onClick={onProposal}>View proposals <span>→</span></button></div><div className="members-card"><div className="section-head compact"><h3>People</h3><button className="text-button">See all</button></div><div className="faces">{members.map((m, i) => <span className={`avatar face f${i}`} key={m[0]}>{m[0]}</span>)}<span className="more-faces">+13</span></div><p>{pool.cap - pool.slots} of {pool.cap} places filled · <b>{pool.slots} sponsored places left</b></p></div></div></div></section>
}

function Proposal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (event: FormEvent) => void }) { return <section className="form-page"><div className="form-intro"><button className="back" onClick={onCancel}>← Back to pool</button><span className="eyebrow">NEW COMMUNITY DECISION</span><h1>Bring an idea<br />to the group.</h1><p>Explain the change clearly. Everyone who is up to date can vote.</p><div className="process"><span>1</span><p><b>Create your proposal</b><small>Set out the decision</small></p><span>2</span><p><b>Community votes</b><small>Open for 7 days</small></p><span>3</span><p><b>Put it into action</b><small>After a short pause</small></p></div></div><form className="form-card" onSubmit={onSubmit}><h2>What should change?</h2><label>Proposal type<select defaultValue=""><option value="" disabled>Choose a change</option><option>Adjust a person’s spending limit</option><option>Change a contribution rule</option><option>Add a community role</option><option>Make room for more members</option></select></label><label>Give your proposal a clear title<input required placeholder="e.g. Increase the garden supply limit" /></label><label>Why does this matter?<textarea required placeholder="Share the context your community needs to decide." rows={4}/></label><div className="form-note">◌ Your proposal will be open for 7 days. It needs 60% support to pass.</div><div className="form-actions"><button type="button" className="ghost" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Continue <span>→</span></button></div></form></section> }

function Withdrawal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (event: FormEvent) => void }) { return <section className="form-page"><div className="form-intro"><button className="back" onClick={onCancel}>← Back to pool</button><span className="eyebrow">REQUEST A PAYMENT</span><h1>Keep every<br />payment clear.</h1><p>Share who it’s for and why before any money moves.</p><div className="trust-note"><b>Why this step?</b><p>Requests help the community understand spending and keep a shared record.</p></div></div><form className="form-card" onSubmit={onSubmit}><h2>Payment details</h2><div className="two-fields"><label>Amount<input required type="number" min="1" step="0.01" placeholder="0.00" /></label><label>For whom?<input required placeholder="Person or organization" /></label></div><label>What is this for?<input required placeholder="e.g. Food pantry supplies" /></label><label>Tell the community more<textarea required placeholder="Add any helpful context." rows={4}/></label><label className="upload">＋ <span><b>Add a receipt or document</b><small>Optional · visible only to your pool</small></span><input type="file" /></label><div className="form-note">◌ This request will be reviewed against the current spending rules.</div><div className="form-actions"><button type="button" className="ghost" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Review request <span>→</span></button></div></form></section> }
