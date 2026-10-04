import { useEffect, useState, type FormEvent } from 'react'
import { NETWORKS, NETWORK_LABELS, type SolanaNetwork } from './network'
import { useWallet } from './wallet'

export function NetworkSwitcher() {
  const wallet = useWallet()
  const [rpc, setRpc] = useState(wallet.endpoint)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setRpc(wallet.endpoint); setError(null) }, [wallet.endpoint, wallet.network])
  const applyRpc = (event: FormEvent) => {
    event.preventDefault()
    try { wallet.setRpcEndpoint(rpc); setError(null) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  return <div className="network-controls">
    <label className="network-select-label">
      <span className="sr-only">Solana network</span>
      <select aria-label="Solana network" value={wallet.network} onChange={event => wallet.setNetwork(event.target.value as SolanaNetwork)}>
        {NETWORKS.map(network => <option key={network} value={network}>{NETWORK_LABELS[network]}</option>)}
      </select>
    </label>
    <span className={`rpc-health ${wallet.networkHealth.status}`} aria-live="polite" data-testid="rpc-health" aria-label="RPC connection health" title={wallet.networkHealth.error ?? wallet.endpoint}>
      <i aria-hidden="true" />{wallet.networkHealth.status === 'online' ? 'Online' : wallet.networkHealth.status === 'offline' ? 'Offline' : 'Checking…'}
    </span>
    <details className="rpc-settings">
      <summary>RPC settings</summary>
      <form onSubmit={applyRpc} className="rpc-settings-card">
        <label>RPC URL for {NETWORK_LABELS[wallet.network]}<input aria-label="RPC URL" value={rpc} onChange={event => setRpc(event.target.value)} /></label>
        <button type="submit" className="primary">Apply RPC</button>
        {error && <p role="alert">{error}</p>}
        {wallet.networkHealth.error && <p>{wallet.networkHealth.error}</p>}
        <p>Match this network in Phantom or Backpack settings. Switching here updates ComFi’s connection.</p>
      </form>
    </details>
  </div>
}
