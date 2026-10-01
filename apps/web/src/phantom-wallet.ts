import { PublicKey } from '@solana/web3.js'

export type PhantomPublicKey = { toBase58: () => string }
type AccountListener = (publicKey: PhantomPublicKey | null) => void
type DisconnectListener = () => void

export interface PhantomProvider {
  isPhantom?: boolean
  publicKey?: PhantomPublicKey | null
  connect: () => Promise<{ publicKey: PhantomPublicKey }>
  disconnect: () => Promise<void>
  on: (event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener) => void
  removeListener: (event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener) => void
}

export type PhantomWindow = {
  phantom?: { solana?: PhantomProvider }
  solana?: PhantomProvider
}

/** Prefer Phantom's dedicated namespace when other extensions also inject window.solana. */
export function getPhantomProvider(browser: PhantomWindow): PhantomProvider | undefined {
  const provider = browser.phantom?.solana?.isPhantom ? browser.phantom.solana : browser.solana
  return provider?.isPhantom ? provider : undefined
}

export function phantomAddress(publicKey: PhantomPublicKey | null | undefined): string {
  if (!publicKey || typeof publicKey.toBase58 !== 'function') {
    throw new Error('Phantom returned a missing public key.')
  }
  return new PublicKey(publicKey.toBase58()).toBase58()
}

/** Owns extension listeners and invalidates pending approvals on mode changes or unmount. */
export class PhantomSession {
  private revision = 0
  private provider?: PhantomProvider
  private notify?: (address?: string) => void

  private accountChanged: AccountListener = publicKey => {
    this.revision++
    this.notify?.(publicKey ? phantomAddress(publicKey) : undefined)
  }
  private disconnected = () => {
    this.revision++
    this.notify?.(undefined)
  }

  attach(provider: PhantomProvider | undefined, notify: (address?: string) => void) {
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
    if (!provider) throw new Error('Phantom is not installed. Install the browser extension and reload this page.')
    const revision = ++this.revision
    const result = await provider.connect()
    const address = phantomAddress(result.publicKey)
    if (revision === this.revision) this.notify?.(address)
  }

  async disconnect() {
    const provider = this.provider
    if (!provider) throw new Error('Phantom is not installed. Install the browser extension and reload this page.')
    const revision = ++this.revision
    await provider.disconnect()
    if (revision === this.revision) this.notify?.(undefined)
  }
}
