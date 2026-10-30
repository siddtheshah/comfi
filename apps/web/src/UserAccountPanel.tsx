import { useEffect, useRef, useState } from 'react'
import { Connection } from '@solana/web3.js'
import { useWallet } from './wallet'
import {
  accountAddresses, accountChainContext, approvalExpiry, authenticator, creationTransaction,
  fetchUserAccount, hex, newCredential, openCredential, parseCredentialBackup, parseCredentialRecord, profileTransaction,
  requireAccountWallet, sealCredential, sha256, type AccountState,
} from './user-account'

export function UserAccountPanel() {
  const wallet = useWallet()
  const [passcode, setPasscode] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [profile, setProfile] = useState('')
  const [storageKey, setStorageKey] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [signature, setSignature] = useState('')
  const alive = useRef(true)
  const operation = useRef(false)
  const connection = new Connection(wallet.endpoint, 'confirmed')

  useEffect(() => {
    alive.current = true
    const clearPasscode = () => { if (document.hidden) { setPasscode(''); setConfirmation('') } }
    document.addEventListener('visibilitychange', clearPasscode)
    const check = async () => {
      const base = requireAccountWallet(wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey)
      const key = await accountChainContext(new Connection(wallet.endpoint, 'confirmed'), base)
      const raw = localStorage.getItem(key)
      if (raw) parseCredentialRecord(raw)
      if (alive.current) { setAccount(null); setStorageKey(key); setSaved(Boolean(raw)) }
    }
    void check().catch(value => { if (alive.current) setError(value instanceof Error ? value.message : String(value)) })
      .finally(() => { if (alive.current) setChecking(false) })
    return () => { alive.current = false; document.removeEventListener('visibilitychange', clearPasscode) }
  }, [wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey])

  const logout = () => {
    if (operation.current || busy) return
    setAccount(null)
    setPasscode('')
    setConfirmation('')
    setProfile('')
    setSignature('')
    setError('')
    setNotice('Logged out of UserAccount.')
  }

  const run = async (action: 'load' | 'create' | 'update') => {
    if (operation.current) return
    operation.current = true
    setBusy(true); setError(''); setNotice(''); setSignature('')
    const suppliedPasscode = passcode
    setPasscode(''); setConfirmation('')
    try {
      const base = requireAccountWallet(wallet.network, wallet.endpoint, wallet.walletMode, wallet.publicKey)
      if (!storageKey) throw new Error('Account setup is not ready. Check the localnet connection.')
      if (!saved && suppliedPasscode !== confirmation) throw new Error('Passcodes do not match.')
      const raw = localStorage.getItem(storageKey)
      if (!raw && action !== 'create') throw new Error('Create a UserAccount first.')
      const credential = raw
        ? await openCredential(parseCredentialRecord(raw), suppliedPasscode, storageKey)
        : await newCredential()
      if (!raw) {
        const encrypted = await sealCredential(credential, suppliedPasscode, storageKey)
        if (!alive.current) throw new Error('Wallet or network changed. Retry with the selected base wallet.')
        // Persist before signing so a rejected or uncertain transaction can be retried
        // with the SAME identity and authenticator, instead of orphaning an account.
        if (localStorage.getItem(storageKey)) throw new Error('An account credential was created in another tab. Reopen User account.')
        localStorage.setItem(storageKey, JSON.stringify(encrypted))
        setSaved(true)
      }
      const auth = await authenticator(credential)
      const current = await fetchUserAccount(connection, auth, base)
      if (!alive.current) throw new Error('Wallet or network changed. Retry with the selected base wallet.')
      setAccount(current)
      if (action === 'load') {
        setNotice(current ? 'Account loaded. Enter your passcode again to authorize a profile update.' : 'Credential saved; creation has not been confirmed. You can retry creation.')
        return
      }
      if (action === 'create' && current) { setNotice('This UserAccount already exists. You can update its profile reference.'); return }
      if (action === 'update' && !current) throw new Error('Create the UserAccount before updating its profile.')
      if (action === 'update' && (!profile.trim() || new TextEncoder().encode(profile).length > 256)) throw new Error('Enter a profile label of 1–256 UTF-8 bytes.')
      const reference = action === 'update' ? await sha256(new TextEncoder().encode(profile)) : undefined
      const expires = await approvalExpiry(connection)
      const transaction = action === 'create'
        ? await creationTransaction(auth, base, expires)
        : await profileTransaction(auth, base, current!, reference!, expires)
      if (!alive.current) throw new Error('Wallet or network changed. Retry with the selected base wallet.')
      setNotice('Approve the transaction with your base wallet…')
      const txSignature = await wallet.sendTransaction(transaction)
      if (!alive.current) return
      setSignature(txSignature)
      setNotice('Transaction confirmed. Verifying account state…')
      const updated = await fetchUserAccount(connection, auth, base)
      if (!updated || (reference && (updated.profileReference !== hex(reference) || updated.nextSequence !== current!.nextSequence + 1n))) throw new Error('Transaction confirmed but account readback does not match. Reload the account before retrying.')
      const { user } = await accountAddresses(auth, base)
      if (updated.address !== user.toBase58()) throw new Error('Confirmed account address does not match the saved credential.')
      if (alive.current) {
        setAccount(updated)
        setNotice(action === 'create' ? 'UserAccount created and verified on localnet.' : 'Profile reference updated and verified on localnet.')
        setProfile('')
      }
    } catch (value) {
      if (alive.current) { setError(value instanceof Error ? value.message : String(value)); setNotice('') }
    } finally {
      operation.current = false
      if (alive.current) setBusy(false)
    }
  }

  const backup = () => {
    try {
      const raw = storageKey && localStorage.getItem(storageKey)
      if (!raw) throw new Error('No account credential is saved.')
      parseCredentialRecord(raw)
      const url = URL.createObjectURL(new Blob([JSON.stringify({ storageKey, credential: JSON.parse(raw) }, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = 'comfi-account-encrypted-backup.json'; link.click()
      URL.revokeObjectURL(url)
    } catch (value) { setError(value instanceof Error ? value.message : String(value)) }
  }

  const restore = async (file: File) => {
    if (!storageKey || operation.current) return
    operation.current = true; setBusy(true); setError('')
    try {
      if (file.size > 16_384) throw new Error('Account backup is too large.')
      const record = parseCredentialBackup(await file.text(), storageKey)
      if (!alive.current) throw new Error('Wallet or network changed. Reopen User account.')
      if (localStorage.getItem(storageKey)) throw new Error('An account credential is already saved. Nothing was overwritten.')
      localStorage.setItem(storageKey, JSON.stringify(record))
      setSaved(true); setPasscode(''); setConfirmation('')
      setNotice('Encrypted backup restored. Enter its passcode and load your account.')
    } catch (value) { if (alive.current) setError(value instanceof Error ? value.message : String(value)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }

  return <section className="page user-account-page" aria-labelledby="user-account-title">
    <p className="eyebrow">Your ComFi identity</p>
    <h1 id="user-account-title">User account</h1>
    <p>Create a stable identity with your base wallet and a browser passcode. Each transaction requires both.</p>
    <div className="user-account-grid">
      <div className="form-card">
        <h2>{account ? 'Update your profile' : saved ? 'Your saved account' : 'Create a UserAccount'}</h2>
        <p className="account-base">Base wallet: <code>{wallet.publicKey ?? 'Disconnected'}</code></p>
        {wallet.walletMode === 'mock' && <button className="primary" onClick={() => wallet.setWalletMode('in-browser')}>Use ComFi base wallet</button>}
        <form onSubmit={event => { event.preventDefault(); void run(account ? 'update' : 'create') }}>
          {account && <label>Profile label
            <input value={profile} onChange={event => setProfile(event.target.value)} placeholder="e.g. My first ComFi profile" disabled={busy} required />
          </label>}
          <label>Browser passcode
            <input type="password" autoComplete={saved ? 'current-password' : 'new-password'} minLength={8} maxLength={128}
              value={passcode} onChange={event => setPasscode(event.target.value)} disabled={busy} required />
          </label>
          {!saved && <label>Confirm passcode
            <input type="password" autoComplete="new-password" minLength={8} maxLength={128}
              value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} required />
          </label>}
          <p className="form-note">Use at least 8 characters. Your passcode encrypts a separate authenticator key in this browser and is required for every account transaction. Keep your passcode and encrypted backup; there is no passcode reset yet.</p>
          <div className="account-actions">
            <button className="primary" type="submit" disabled={busy || checking || !storageKey}>
              {busy ? 'Working…' : account ? 'Send test update' : saved ? 'Create or recover account' : 'Create UserAccount'}
            </button>
            {saved && !account && <button className="ghost" type="button" onClick={() => void run('load')} disabled={busy || !storageKey || !passcode}>Load account</button>}
            {account && <button className="ghost" type="button" onClick={logout} disabled={busy}>Log out</button>}
          </div>
        </form>
        {checking && <p role="status">Checking the localnet account program…</p>}
        {error && <p className="account-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <aside className="form-card account-details">
        <h2>Account details</h2>
        {account ? <dl>
          <dt>UserAccount address</dt><dd data-testid="user-account-address">{account.address}</dd>
          <dt>Next approval sequence</dt><dd data-testid="user-account-sequence">{account.nextSequence.toString()}</dd>
          <dt>Profile reference</dt><dd data-testid="user-account-profile">{account.profileReference}</dd>
        </dl> : <p>{saved ? 'Enter your passcode and load the saved account to see its on-chain state.' : 'Your account address will appear after creation is confirmed.'}</p>}
        {signature && <><h3>Confirmed transaction</h3><code data-testid="user-account-signature">{signature}</code></>}
        {saved && <button className="ghost" onClick={backup}>Download encrypted backup</button>}
        {!saved && storageKey && <label>Restore encrypted backup
          <input type="file" accept="application/json,.json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (file) void restore(file)
          }} />
        </label>}
        <p className="account-explainer">The test update writes the SHA-256 hash of your profile label to the account’s profile reference. Your passcode and authenticator private key stay in the browser.</p>
        <p className="account-explainer">This is a localnet browser authenticator for testing, not a hardware passkey. The base wallet pays SOL fees and account rent. Pool integration is a separate step.</p>
      </aside>
    </div>
  </section>
}
