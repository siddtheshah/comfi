export const NETWORKS = ['localnet', 'devnet', 'testnet'] as const
export type SolanaNetwork = typeof NETWORKS[number]
export const NETWORK_LABELS: Record<SolanaNetwork, string> = { localnet: 'Localnet', devnet: 'Devnet', testnet: 'Testnet' }
export const DEFAULT_RPC: Record<SolanaNetwork, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
}

export function validateNetwork(value: string): SolanaNetwork {
  if (!NETWORKS.includes(value as SolanaNetwork)) throw new Error(`Unsupported Solana network: ${value}`)
  return value as SolanaNetwork
}

export function validateRpcEndpoint(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter an HTTP or HTTPS RPC URL.')
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS RPC URL without embedded credentials.')
  }
  return value.trim()
}

export function initialNetwork(endpoint: string, explicitNetwork?: string): SolanaNetwork {
  const url = new URL(validateRpcEndpoint(endpoint))
  if (explicitNetwork) return validateNetwork(explicitNetwork)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'localnet'
  if (url.hostname === 'api.devnet.solana.com') return 'devnet'
  if (url.hostname === 'api.testnet.solana.com') return 'testnet'
  throw new Error('Set VITE_SOLANA_NETWORK to localnet, devnet, or testnet for a custom initial RPC.')
}

export function networkEndpoints(endpoint: string, network: SolanaNetwork, overrides: Partial<Record<SolanaNetwork, string>> = {}): Record<SolanaNetwork, string> {
  validateNetwork(network)
  const endpoints = { ...DEFAULT_RPC }
  for (const name of NETWORKS) {
    if (overrides[name]) endpoints[name] = validateRpcEndpoint(overrides[name])
  }
  endpoints[network] = validateRpcEndpoint(endpoint)
  return endpoints
}

/** Rejects HTTP, RPC, malformed, timeout, and transport failures for the UI to present. */
export async function checkRpcHealth(endpoint: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(5000)
  const response = await fetch(validateRpcEndpoint(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'comfi-health', method: 'getHealth' }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}.`)
  const json = await response.json() as { result?: unknown; error?: { message?: string } }
  if (json.error) throw new Error(`RPC health error: ${json.error.message ?? 'Unknown RPC error'}`)
  if (json.result !== 'ok') throw new Error('RPC did not report a healthy node.')
}
