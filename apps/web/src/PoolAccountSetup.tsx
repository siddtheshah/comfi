import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { useWallet } from './wallet'
import { requireAccountWallet } from './user-account'
import { checkPoolSetup, defaultPoolSetup, linkedUserAccounts, loadPoolSetup, poolSetupTransaction, savePoolSetup, verifyPoolSetup, type PoolSetupParams, type PoolSetupReceipt } from './pool-setup'

export function PoolAccountSetup({ onClose, onAccount, onCreated }: { onClose: () => void; onAccount: () => void; onCreated: (pool: string) => void }) {
  const wallet = useWallet()
  const [users, setUsers] = useState<string[]>([])
  const [user, setUser] = useState('')
  const [params, setParams] = useState<PoolSetupParams>({ ...defaultPoolSetup })
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [signature, setSignature] = useState('')
  const [expiry, setExpiry] = useState(0)
  const [pending, setPending] = useState<PoolSetupReceipt>()
  const [storageKey, setStorageKey] = useState('')
  const alive = useRef(true), running = useRef(false)
  useEffect(() => {
    alive.current = true
    const load = async () => {
      const base = requireAccountWallet(wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey)
      const connection = new Connection(wallet.endpoint, 'confirmed')
      const key = `comfi:pool-setup:v1:${await connection.getGenesisHash()}:${wallet.programId}:${base.toBase58()}`
      const raw = localStorage.getItem(key)
      const saved = raw ? loadPoolSetup(raw, base) : null
      const found = await linkedUserAccounts(connection, base)
      if (alive.current && saved) { setPending(saved.receipt); setParams(saved.receipt.params); setUser(saved.receipt.user.toBase58()); setSignature(saved.signature); setExpiry(saved.expiry) }
      if (alive.current) setStorageKey(key)
      if (alive.current) { setUsers(found); setUser(saved ? saved.receipt.user.toBase58() : found.length === 1 ? found[0] : '') }
    }
    void load().catch(value => { if (alive.current) setError(value instanceof Error ? value.message : String(value)) })
      .finally(() => { if (alive.current) setChecking(false) })
    return () => { alive.current = false }
  }, [wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const base = requireAccountWallet(wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey)
      const connection = new Connection(wallet.endpoint, 'confirmed'), program = new PublicKey(wallet.programId)
      if (!user) throw new Error('Select a linked UserAccount before deploying.')
      if (pending) {
        const state = await checkPoolSetup(connection, program, pending, signature, expiry)
        if (state === 'pending') throw new Error('Deployment is still unconfirmed. Check again before starting another pool.')
        if (state === 'retryable') {
          localStorage.removeItem(storageKey)
          setPending(undefined); setSignature(''); setExpiry(0)
          throw new Error('The previous transaction failed or expired without creating this pool. You can approve a new deployment.')
        }
        localStorage.removeItem(storageKey)
        if (alive.current) onCreated(pending.pool.toBase58())
        return
      }
      const plan = await poolSetupTransaction(connection, program, new PublicKey(user), base, { ...params })
      if (!alive.current) throw new Error('Wallet or network changed. Reopen pool setup.')
      if (!storageKey) throw new Error('Pool setup storage is not ready.')
      // Keep the exact expected address after submission begins. An uncertain
      // confirmation must be checked rather than creating a second pool.
      const tx = await wallet.sendTransaction(plan.transaction, (submitted, latest) => {
        const { transaction: _transaction, ...receipt } = plan
        localStorage.setItem(storageKey, savePoolSetup(receipt, submitted, latest.lastValidBlockHeight))
        if (alive.current) { setPending(receipt); setSignature(submitted); setExpiry(latest.lastValidBlockHeight) }
      })
      if (!alive.current) return
      setSignature(tx)
      await verifyPoolSetup(connection, program, plan)
      localStorage.removeItem(storageKey)
      if (alive.current) onCreated(plan.pool.toBase58())
    } catch (value) {
      if (alive.current) setError(value instanceof Error ? value.message : String(value))
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="wallet-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="account-pool-title">
    <div className="create-pool-modal-card account-pool-setup">
      <div className="wallet-modal-header"><h2 id="account-pool-title">Set up your pool</h2><button aria-label="Close pool setup" disabled={busy} onClick={onClose}>✕</button></div>
      <p>Create a pool with your linked wallet on Localnet.</p>
      {error && <p className="wallet-alert error" role="alert">{error}</p>}
      {checking ? <p role="status">Checking account links…</p> : users.length === 0 ? <div>
        <p>No active UserAccount link was found for this wallet.</p><button className="primary" onClick={onAccount}>Set up UserAccount</button>
      </div> : <form className="create-pool-form" onSubmit={event => { void submit(event) }}>
        <fieldset disabled={busy || Boolean(pending)}>
          <label className="field-label">UserAccount<select aria-label="UserAccount" required value={user} onChange={event => setUser(event.target.value)}><option value="">Select an account</option>{users.map(address => <option key={address} value={address}>{address}</option>)}</select></label>
          <p className="field-hint">Your selected wallet signs, pays SOL fees and account rent, and funds the USDC deposit.</p>
          <code className="pool-setup-address" data-testid="pool-setup-wallet">{wallet.publicKey}</code>
          <div className="form-grid-2">
            {([['minimumDeposit', 'Minimum deposit (USDC)'], ['obligation', 'Contribution per cycle (USDC)'], ['initialDeposit', 'Your initial deposit (USDC)']] as const).map(([key, label]) => <label key={key} className="field-label">{label}<input required inputMode="decimal" value={params[key]} onChange={event => setParams({ ...params, [key]: event.target.value })} /></label>)}
            <label className="field-label">Member capacity<input required type="number" min="2" max="500" value={params.memberCap} onChange={event => setParams({ ...params, memberCap: Number(event.target.value) })} /></label>
            <label className="field-label">Cycle duration (days)<input required type="number" min="1" max="365" value={params.cycleDays} onChange={event => setParams({ ...params, cycleDays: Number(event.target.value) })} /></label>
            <label className="field-label">Vote threshold (basis points)<input required type="number" min="5001" max="10000" value={params.voteThreshold} onChange={event => setParams({ ...params, voteThreshold: Number(event.target.value) })} /></label>
          </div>
        </fieldset>
        <div className="form-note">Payment: <strong>{params.initialDeposit} USDC</strong> to the pool vault, plus a <strong>1 USDC</strong> enrollment fee to the deployment treasury. SOL fees and rent are additional.</div>
        <p className="field-hint">New pools use invite-vouched admission, a minimum quorum of 1 member, and no automatic closure. Pool permissions stay with this wallet; switching wallets requires an existing Member account for that wallet.</p>
        {pending && <p className="field-hint">Expected pool: <code className="pool-setup-address">{pending.pool.toBase58()}</code>Check its state before starting another deployment.</p>}
        {signature && <p className="pool-setup-address">Transaction: {signature}</p>}
        <div className="modal-actions-footer"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Close</button><button className="primary" disabled={busy || !user} type="submit">{busy ? 'Verifying pool…' : pending ? 'Check deployment' : 'Approve and deploy pool'}</button></div>
      </form>}
    </div>
  </div>
}
