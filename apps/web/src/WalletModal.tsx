import React, { useRef, useState } from 'react'
import { useWallet } from './wallet'

interface WalletModalProps {
  isOpen: boolean
  onClose: () => void
}

export function WalletModal({ isOpen, onClose }: WalletModalProps) {
  const wallet = useWallet()
  const { inBrowserWallet, walletMode, setWalletMode } = wallet

  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [importInput, setImportInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const activeMode = useRef({ mode: walletMode, revision: 0 })
  if (activeMode.current.mode !== walletMode) {
    activeMode.current = { mode: walletMode, revision: activeMode.current.revision + 1 }
  }

  if (!isOpen) return null

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(fieldName)
      setTimeout(() => setCopiedField(null), 2000)
    } catch {
      // Fallback
      setCopiedField(fieldName)
      setTimeout(() => setCopiedField(null), 2000)
    }
  }

  const handleImport = () => {
    setImportError(null)
    try {
      if (!importInput.trim()) {
        throw new Error('Please enter a secret key (Base58 or JSON byte array).')
      }
      inBrowserWallet.importSecret(importInput)
      setImportInput('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setImportError(msg)
    }
  }

  const handleGenerate = () => {
    if (!confirmGenerate) {
      setConfirmGenerate(true)
      return
    }
    inBrowserWallet.generateNew()
    setConfirmGenerate(false)
  }

  const activePubkey = wallet.publicKey
  // The wallet API rejects failures; this boundary presents them in the modal.
  const runWalletAction = (action: () => Promise<void>) => {
    const requestedRevision = activeMode.current.revision
    setImportError(null)
    void action().then(() => {}, error => {
      if (activeMode.current.revision === requestedRevision) setImportError(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <div className="wallet-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="wallet-modal-card" onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="wallet-modal-header">
          <div>
            <div className="wallet-modal-badge">
              <span className="network-dot" />
              <span>{wallet.endpoint.includes('127.0.0.1') || wallet.endpoint.includes('localhost') ? 'Localnet' : wallet.endpoint.includes('testnet') ? 'Testnet' : wallet.endpoint.includes('devnet') ? 'Devnet' : 'Custom RPC'}</span>
            </div>
            <h2>ComFi Wallet Manager</h2>
          </div>
          <button className="wallet-modal-close" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>

        {/* Mode Selector */}
        <div className="wallet-mode-tabs">
          <button
            type="button"
            className={`wallet-mode-tab ${walletMode === 'phantom' ? 'active' : ''}`}
            onClick={() => { setImportError(null); setWalletMode('phantom') }}
          >
            Phantom
          </button>
          <button
            type="button"
            className={`wallet-mode-tab ${walletMode === 'backpack' ? 'active' : ''}`}
            onClick={() => { setImportError(null); setWalletMode('backpack') }}
          >
            🎒 Backpack
          </button>
          <button
            type="button"
            className={`wallet-mode-tab ${walletMode === 'in-browser' ? 'active' : ''}`}
            onClick={() => { setImportError(null); setWalletMode('in-browser') }}
          >
            ⚡ In-Browser Wallet
          </button>
          <button
            type="button"
            className={`wallet-mode-tab ${walletMode === 'mock' ? 'active' : ''}`}
            onClick={() => { setImportError(null); setWalletMode('mock') }}
          >
            🧪 Mock Test Identity
          </button>
        </div>

        {/* Active Address Card */}
        <div className="wallet-address-card">
          <div className="wallet-address-head">
            <span className="wallet-card-label">Active Wallet Address</span>
            <button
              type="button"
              className="copy-btn"
              disabled={!activePubkey}
              onClick={() => activePubkey && void copyToClipboard(activePubkey, 'activePubkey')}
            >
              {copiedField === 'activePubkey' ? '✓ Copied' : '📋 Copy Address'}
            </button>
          </div>
          <div className="wallet-pubkey-display" title={activePubkey}>
            {activePubkey ?? 'Connect a wallet to see its address.'}
          </div>
        </div>

        {wallet.connectionError && <p className="wallet-alert error" role="alert">{wallet.connectionError}</p>}

        {/* In-Browser Wallet Content */}
        {walletMode === 'in-browser' ? (
          <>
            {/* Balances Card */}
            <div className="wallet-balances-card">
              <div className="wallet-balance-row">
                <div className="wallet-balance-col">
                  <span className="balance-token-label">SOL Balance</span>
                  <div className="balance-token-value">
                    {inBrowserWallet.solBalance !== null
                      ? `${inBrowserWallet.solBalance.toFixed(4)} SOL`
                      : '0.0000 SOL'}
                  </div>
                </div>
                <div className="wallet-balance-col">
                  <span className="balance-token-label">USDC Balance</span>
                  <div className="balance-token-value">
                    {inBrowserWallet.usdcBalance ?? '$0.00'}
                  </div>
                </div>
                <button
                  type="button"
                  className="refresh-balance-btn"
                  onClick={() => void inBrowserWallet.refreshBalances()}
                  disabled={inBrowserWallet.isLoadingBalance}
                  title="Refresh SOL & USDC balances"
                >
                  {inBrowserWallet.isLoadingBalance ? '↻ …' : '↻ Refresh'}
                </button>
              </div>
            </div>

            {/* Notification & Status Banners */}
            {inBrowserWallet.statusMessage && (
              <div className="wallet-alert success">
                <span>{inBrowserWallet.statusMessage}</span>
                <button onClick={inBrowserWallet.clearMessages}>✕</button>
              </div>
            )}
            {inBrowserWallet.errorMessage && (
              <div className="wallet-alert error">
                <span>{inBrowserWallet.errorMessage}</span>
                <button onClick={inBrowserWallet.clearMessages}>✕</button>
              </div>
            )}

            {/* Localnet / Devnet Airdrop Faucet */}
            <div className="wallet-faucet-card">
              <span className="wallet-card-label">Localnet & Devnet Faucet</span>
              <p className="wallet-card-desc">
                Instantly fund your browser keypair with test SOL and USDC.
              </p>
              <div className="wallet-faucet-actions">
                <button
                  type="button"
                  className="faucet-btn primary-faucet"
                  onClick={() => void inBrowserWallet.requestAirdrop(1)}
                  disabled={inBrowserWallet.isAirdropping}
                >
                  {inBrowserWallet.isAirdropping ? 'Requesting…' : '💧 Request 1 SOL'}
                </button>
                <button
                  type="button"
                  className="faucet-btn secondary-faucet"
                  onClick={() => void inBrowserWallet.requestUsdcFaucet(100)}
                  disabled={inBrowserWallet.isAirdropping}
                >
                  {inBrowserWallet.isAirdropping ? 'Minting…' : '💵 Mint 100 USDC'}
                </button>
              </div>
            </div>

            {/* Key Management: Generate / Export / Import */}
            <div className="wallet-management-card">
              <span className="wallet-card-label">Keypair Management</span>
              
              <div className="wallet-actions-row">
                <button
                  type="button"
                  className={`btn-subtle ${confirmGenerate ? 'btn-danger' : ''}`}
                  onClick={handleGenerate}
                >
                  {confirmGenerate ? '⚠️ Confirm Overwrite?' : '🔑 1-Click New Keypair'}
                </button>

                <button
                  type="button"
                  className="btn-subtle"
                  onClick={() => setShowExport(!showExport)}
                >
                  {showExport ? 'Hide Export' : '📤 Export Secret Key'}
                </button>
              </div>

              {/* Export Panel */}
              {showExport && (
                <div className="wallet-export-panel">
                  <div className="export-field">
                    <div className="export-field-head">
                      <span>Base58 Private Key</span>
                      <button
                        type="button"
                        className="copy-btn-mini"
                        onClick={() => void copyToClipboard(inBrowserWallet.exportSecretBase58(), 'base58Key')}
                      >
                        {copiedField === 'base58Key' ? '✓ Copied' : 'Copy Base58'}
                      </button>
                    </div>
                    <code className="export-secret-code">{inBrowserWallet.exportSecretBase58()}</code>
                  </div>

                  <div className="export-field">
                    <div className="export-field-head">
                      <span>JSON Array Format</span>
                      <button
                        type="button"
                        className="copy-btn-mini"
                        onClick={() => void copyToClipboard(inBrowserWallet.exportSecretJson(), 'jsonKey')}
                      >
                        {copiedField === 'jsonKey' ? '✓ Copied' : 'Copy JSON'}
                      </button>
                    </div>
                    <code className="export-secret-code">{inBrowserWallet.exportSecretJson()}</code>
                  </div>
                  <small className="export-warning">⚠️ Store this secret key safely. Anyone with this key controls the wallet.</small>
                </div>
              )}

              {/* Import Panel */}
              <div className="wallet-import-panel">
                <span className="wallet-sublabel">Import Existing Private Key</span>
                <div className="import-row">
                  <input
                    type="password"
                    className="import-input"
                    placeholder="Paste Base58 string or [1,2,3...] JSON array"
                    value={importInput}
                    onChange={e => setImportInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className="import-btn"
                    onClick={handleImport}
                  >
                    Import Key
                  </button>
                </div>
                {importError && <p className="import-error-msg">{importError}</p>}
              </div>
            </div>
          </>
        ) : walletMode === 'phantom' ? (
          <div className="mock-wallet-view phantom-wallet-view">
            <h3>Phantom browser wallet</h3>
            {!wallet.phantomAvailable && <p>Install <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Phantom</a> and reload this page to connect.</p>}
            <p>App RPC: <code>{wallet.endpoint}</code></p>
            <p>In Phantom, open Settings → Developer Settings → Change Network and select the same network as the app. Some versions call this Testnet Mode.</p>
            <p>For localnet, select or configure <code>http://127.0.0.1:8899</code> if your Phantom version supports a custom RPC. If it does not, use the in-browser wallet for localnet.</p>
            <p>ComFi cannot change or verify Phantom’s selected network. Connecting shares your public address; it does not sign a transaction.</p>
            <button type="button" className="primary" disabled={!wallet.phantomAvailable || wallet.isConnecting || wallet.connected}
              onClick={() => runWalletAction(wallet.connect)}>
              {wallet.isConnecting ? 'Connecting…' : wallet.connected ? 'Phantom connected' : 'Connect Phantom'}
            </button>
          </div>
        ) : walletMode === 'backpack' ? (
          <div className="mock-wallet-view backpack-wallet-view">
            <h3>Backpack browser wallet</h3>
            {!wallet.backpackAvailable && (
              <p>
                Install <a href="https://backpack.app/download" target="_blank" rel="noreferrer">Backpack</a> and reload this page to connect.
              </p>
            )}
            <p>App RPC: <code>{wallet.endpoint}</code></p>
            <div className="backpack-rpc-guide">
              <h4>Native Custom RPC Configuration</h4>
              <p>
                Backpack natively supports custom RPC endpoints without browser flag workarounds.
                To configure Backpack for this app ({wallet.backpackRpcConfig.networkName}):
              </p>
              <ol className="backpack-steps-list">
                {wallet.backpackRpcConfig.setupSteps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
              <p className="backpack-rpc-note">
                {wallet.backpackRpcConfig.isCustomOrLocalnet
                  ? 'Connecting to localnet or custom RPC allows full local simulation without devnet airdrop limits.'
                  : 'Backpack will submit transactions directly to the selected network.'}
              </p>
            </div>
            <p>ComFi cannot alter your extension settings. Connecting shares your public address; it does not sign a transaction.</p>
            <button
              type="button"
              className="primary"
              disabled={!wallet.backpackAvailable || wallet.isConnecting || wallet.connected}
              onClick={() => runWalletAction(wallet.connect)}
            >
              {wallet.isConnecting ? 'Connecting…' : wallet.connected ? 'Backpack connected' : 'Connect Backpack'}
            </button>
          </div>
        ) : (
          /* Mock Wallet View */
          <div className="mock-wallet-view">
            <div className="mock-explainer">
              <h3>Localnet Test Identity</h3>
              <p>
                Using the pre-funded mock wallet identity configured in <code>.env</code>.
                This identity is automatically used during automated localnet tests and Playwright CUJ workflows.
              </p>
            </div>
            <div className="wallet-actions-row">
              <button
                type="button"
                className="primary"
                onClick={() => { setImportError(null); setWalletMode('in-browser') }}
              >
                Switch to In-Browser Web Wallet
              </button>
            </div>
          </div>
        )}

        {importError && (walletMode === 'phantom' || walletMode === 'backpack') && !wallet.connectionError && (
          <p role="alert" className="import-error-msg">{importError}</p>
        )}

        {/* Modal Footer */}
        <div className="wallet-modal-footer">
          <button
            type="button"
            className="disconnect-btn"
            disabled={wallet.isConnecting || (walletMode === 'phantom' && !wallet.phantomAvailable) || (walletMode === 'backpack' && !wallet.backpackAvailable)}
            onClick={() => runWalletAction(wallet.connected ? wallet.disconnect : wallet.connect)}
          >
            {wallet.connected ? 'Disconnect' : 'Connect Wallet'}
          </button>
          <button type="button" className="close-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
