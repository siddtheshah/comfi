import { PublicKey, type Transaction } from '@solana/web3.js'

export type BackpackPublicKey = { toBase58: () => string }
type AccountListener = (publicKey: BackpackPublicKey | null) => void
type DisconnectListener = () => void

export interface BackpackProvider {
  isBackpack?: boolean
  publicKey?: BackpackPublicKey | null
  connect: () => Promise<{ publicKey?: BackpackPublicKey } | void>
  disconnect: () => Promise<void>
  signTransaction?: (transaction: Transaction) => Promise<Transaction>
  on: (event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener) => void
  removeListener: (event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener) => void
  connection?: { rpcEndpoint?: string }
}

export type BackpackWindow = {
  backpack?: { solana?: BackpackProvider } | BackpackProvider
  solana?: BackpackProvider
}

export interface BackpackRpcConfig {
  endpoint: string
  networkName: string
  isCustomOrLocalnet: boolean
  setupSteps: string[]
}

/** Prefer Backpack's dedicated namespace when other extensions also inject window.solana. */
export function getBackpackProvider(browser: BackpackWindow): BackpackProvider | undefined {
  const backpackObj = browser.backpack
  if (backpackObj) {
    if ('solana' in backpackObj && backpackObj.solana?.isBackpack) {
      return backpackObj.solana
    }
    if ('isBackpack' in backpackObj && backpackObj.isBackpack) {
      return backpackObj as BackpackProvider
    }
  }
  return browser.solana?.isBackpack ? browser.solana : undefined
}

export function backpackAddress(publicKey: BackpackPublicKey | null | undefined): string {
  if (!publicKey || typeof publicKey.toBase58 !== 'function') {
    throw new Error('Backpack returned a missing public key.')
  }
  return new PublicKey(publicKey.toBase58()).toBase58()
}

/** Formats native custom RPC configuration and setup instructions for Backpack. */
export function getBackpackRpcConfig(endpoint: string): BackpackRpcConfig {
  if (!endpoint || typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new Error('A valid endpoint string is required for Backpack RPC configuration.')
  }
  const trimmed = endpoint.trim()
  const isLocal = trimmed.includes('127.0.0.1') || trimmed.includes('localhost')
  const isDevnet = trimmed.includes('devnet')
  const isTestnet = trimmed.includes('testnet')
  const isMainnet = trimmed.includes('mainnet')

  let networkName = 'Custom RPC'
  if (isLocal) networkName = 'Localnet'
  else if (isDevnet) networkName = 'Devnet'
  else if (isTestnet) networkName = 'Testnet'
  else if (isMainnet) networkName = 'Mainnet'

  return {
    endpoint: trimmed,
    networkName,
    isCustomOrLocalnet: isLocal || networkName === 'Custom RPC',
    setupSteps: [
      'Open Backpack extension and click the Settings gear icon (⚙️).',
      'Navigate to Preferences → Solana → RPC Connection (or Networks).',
      `Select "Custom RPC" and enter "${trimmed}".`,
      'Confirm settings to route all Backpack transactions directly through this RPC endpoint.',
    ],
  }
}

/** Owns extension listeners and invalidates pending approvals on mode changes or unmount. */
export class BackpackSession {
  private revision = 0
  private provider?: BackpackProvider
  private notify?: (address?: string) => void

  private accountChanged: AccountListener = publicKey => {
    this.revision++
    this.notify?.(publicKey ? backpackAddress(publicKey) : undefined)
  }
  private disconnected = () => {
    this.revision++
    this.notify?.(undefined)
  }

  attach(provider: BackpackProvider | undefined, notify: (address?: string) => void) {
    this.detach()
    this.provider = provider
    this.notify = notify
    provider?.on('accountChanged', this.accountChanged)
    provider?.on('disconnect', this.disconnected)
  }

  detach() {
    this.revision++
    this.provider?.removeListener('accountChanged', this.accountChanged)
    this.provider?.removeListener('disconnect', this.disconnected)
    this.provider = undefined
    this.notify = undefined
  }

  async connect() {
    const provider = this.provider
    if (!provider) throw new Error('Backpack is not installed. Install the browser extension and reload this page.')
    const revision = ++this.revision
    const result = await provider.connect()
    const pubkey = result && typeof result === 'object' && 'publicKey' in result && result.publicKey
      ? result.publicKey
      : provider.publicKey
    const address = backpackAddress(pubkey)
    if (revision === this.revision) this.notify?.(address)
  }

  async disconnect() {
    const provider = this.provider
    if (!provider) throw new Error('Backpack is not installed. Install the browser extension and reload this page.')
    const revision = ++this.revision
    await provider.disconnect()
    if (revision === this.revision) this.notify?.(undefined)
  }
}
