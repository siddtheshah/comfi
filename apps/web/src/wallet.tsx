import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Keypair } from '@solana/web3.js'
import { getPhantomProvider, PhantomSession, type PhantomWindow } from './phantom-wallet'
import {
  getBackpackProvider,
  BackpackSession,
  type BackpackWindow,
  type BackpackRpcConfig,
  getBackpackRpcConfig,
} from './backpack-wallet'
import {
  exportKeypair,
  fetchSolBalance,
  fetchUsdcBalance,
  generateNewKeypair,
  getOrCreateInBrowserKeypair,
  importKeypairFromSecret,
  requestSolAirdrop,
  storeWalletSecret,
} from './in-browser-wallet'

function requireEnv(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Configure it in .env.`)
  }
  return value
}

export type WalletMode = 'mock' | 'in-browser' | 'phantom' | 'backpack'

export type InBrowserWalletState = {
  keypair: Keypair
  publicKey: string
  solBalance: number | null
  usdcBalance: string | null
  isLoadingBalance: boolean
  isAirdropping: boolean
  statusMessage: string | null
  errorMessage: string | null
  generateNew: () => void
  importSecret: (secret: string) => void
  exportSecretBase58: () => string
  exportSecretJson: () => string
  requestAirdrop: (solAmount?: number) => Promise<string>
  requestUsdcFaucet: (amount?: number) => Promise<void>
  refreshBalances: () => Promise<void>
  clearMessages: () => void
}

export type WalletState = {
  connected: boolean
  endpoint: string
  publicKey?: string
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  isConnecting: boolean
  phantomAvailable: boolean
  backpackAvailable: boolean
  backpackRpcConfig: BackpackRpcConfig
  connectionError: string | null
  walletLabel: string
  walletMode: WalletMode
  setWalletMode: (mode: WalletMode) => void
  inBrowserWallet: InBrowserWalletState
  mockWallet: {
    publicKey: string
    endpoint: string
  }
}

const WalletContext = createContext<WalletState | undefined>(undefined)

export function MockWalletProvider({ children }: PropsWithChildren) {
  const endpoint = requireEnv('VITE_SOLANA_RPC', import.meta.env.VITE_SOLANA_RPC)
  const mockPublicKey = requireEnv('VITE_MOCK_WALLET_PUBLIC_KEY', import.meta.env.VITE_MOCK_WALLET_PUBLIC_KEY)

  const [walletMode, updateWalletMode] = useState<WalletMode>('mock')
  const [connected, setConnected] = useState(true)

  const [phantomPublicKey, setPhantomPublicKey] = useState<string>()
  const [backpackPublicKey, setBackpackPublicKey] = useState<string>()
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const connectionRevision = useRef(0)
  const phantomSession = useMemo(() => new PhantomSession(), [])
  const phantomProvider = getPhantomProvider(window as PhantomWindow)
  const backpackSession = useMemo(() => new BackpackSession(), [])
  const backpackProvider = getBackpackProvider(window as BackpackWindow)
  const backpackRpcConfig = useMemo(() => getBackpackRpcConfig(endpoint), [endpoint])

  useEffect(() => {
    if (walletMode !== 'phantom') return
    phantomSession.attach(phantomProvider, setPhantomPublicKey)
    return () => {
      connectionRevision.current++
      phantomSession.detach()
    }
  }, [walletMode, phantomProvider, phantomSession])

  useEffect(() => {
    if (walletMode !== 'backpack') return
    backpackSession.attach(backpackProvider, setBackpackPublicKey)
    return () => {
      connectionRevision.current++
      backpackSession.detach()
    }
  }, [walletMode, backpackProvider, backpackSession])

  const setWalletMode = useCallback((mode: WalletMode) => {
    if (mode === walletMode) return
    connectionRevision.current++
    // Invalidate an extension approval immediately, before React runs effect cleanup.
    phantomSession.detach()
    backpackSession.detach()
    setPhantomPublicKey(undefined)
    setBackpackPublicKey(undefined)
    setConnectionError(null)
    setIsConnecting(false)
    updateWalletMode(mode)
    setConnected(mode !== 'phantom' && mode !== 'backpack')
  }, [phantomSession, backpackSession, walletMode])

  const connect = useCallback(async () => {
    setConnectionError(null)
    if (walletMode !== 'phantom' && walletMode !== 'backpack') {
      setConnected(true)
      return
    }
    const revision = ++connectionRevision.current
    setIsConnecting(true)
    try {
      if (walletMode === 'phantom') {
        await phantomSession.connect()
      } else if (walletMode === 'backpack') {
        await backpackSession.connect()
      }
    } catch (error: unknown) {
      if (revision === connectionRevision.current) setConnectionError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (revision === connectionRevision.current) setIsConnecting(false)
    }
  }, [walletMode, phantomSession, backpackSession])

  const disconnect = useCallback(async () => {
    setConnectionError(null)
    if (walletMode !== 'phantom' && walletMode !== 'backpack') {
      setConnected(false)
      return
    }
    const revision = ++connectionRevision.current
    try {
      if (walletMode === 'phantom') {
        await phantomSession.disconnect()
      } else if (walletMode === 'backpack') {
        await backpackSession.disconnect()
      }
    } catch (error: unknown) {
      if (revision === connectionRevision.current) setConnectionError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [walletMode, phantomSession, backpackSession])

  // In-browser keypair state
  const [keypair, setKeypair] = useState<Keypair>(() => getOrCreateInBrowserKeypair())
  const [solBalance, setSolBalance] = useState<number | null>(null)
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null)
  const [isLoadingBalance, setIsLoadingBalance] = useState(false)
  const [isAirdropping, setIsAirdropping] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const clearMessages = useCallback(() => {
    setStatusMessage(null)
    setErrorMessage(null)
  }, [])

  const refreshBalances = useCallback(async () => {
    if (!endpoint || !keypair) return
    setIsLoadingBalance(true)
    clearMessages()
    try {
      const pubkey = keypair.publicKey.toBase58()
      const sol = await fetchSolBalance(endpoint, pubkey)
      setSolBalance(sol)
      const usdc = await fetchUsdcBalance(endpoint, pubkey)
      setUsdcBalance(usdc)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Could not refresh in-browser wallet balances:', msg)
      setErrorMessage(msg)
    } finally {
      setIsLoadingBalance(false)
    }
  }, [endpoint, keypair, clearMessages])

  const generateNew = useCallback(() => {
    clearMessages()
    const { keypair: newKp, exportData } = generateNewKeypair()
    storeWalletSecret(exportData.secretKeyBase58)
    setKeypair(newKp)
    setSolBalance(0)
    setUsdcBalance('$0.00')
    setStatusMessage('New in-browser wallet generated successfully!')
  }, [clearMessages])

  const importSecret = useCallback((input: string) => {
    clearMessages()
    if (!input || input.trim().length === 0) {
      throw new Error('Secret key input cannot be empty.')
    }
    const imported = importKeypairFromSecret(input)
    const exported = exportKeypair(imported)
    storeWalletSecret(exported.secretKeyBase58)
    setKeypair(imported)
    setStatusMessage('Wallet imported successfully!')
    void refreshBalances()
  }, [clearMessages, refreshBalances])

  const exportSecretBase58 = useCallback(() => {
    return exportKeypair(keypair).secretKeyBase58
  }, [keypair])

  const exportSecretJson = useCallback(() => {
    return exportKeypair(keypair).secretKeyJson
  }, [keypair])

  const requestAirdrop = useCallback(async (solAmount = 1): Promise<string> => {
    clearMessages()
    if (solAmount <= 0) {
      throw new Error('Airdrop amount must be greater than 0.')
    }
    setIsAirdropping(true)
    try {
      const pubkey = keypair.publicKey.toBase58()
      const sig = await requestSolAirdrop(endpoint, pubkey, solAmount)
      setStatusMessage(`Airdrop of ${solAmount} SOL requested! Tx: ${sig.slice(0, 10)}…`)
      setTimeout(() => { void refreshBalances() }, 1500)
      return sig
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      throw err
    } finally {
      setIsAirdropping(false)
    }
  }, [endpoint, keypair, clearMessages, refreshBalances])

  const requestUsdcFaucet = useCallback(async (amount = 100): Promise<void> => {
    clearMessages()
    setIsAirdropping(true)
    try {
      const pubkey = keypair.publicKey.toBase58()
      const res = await fetch('http://localhost:5174/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'fund_wallet',
          payload: { walletName: 'creator', solAmount: 0, usdcAmount: amount },
        }),
      }).catch(() => null)

      if (res && res.ok) {
        setStatusMessage(`Minted ${amount} test USDC on localnet!`)
      } else {
        setStatusMessage(`Test USDC faucet triggered for ${amount} USDC on ${pubkey.slice(0, 4)}…`)
      }
      setTimeout(() => { void refreshBalances() }, 1000)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      throw err
    } finally {
      setIsAirdropping(false)
    }
  }, [clearMessages, keypair, refreshBalances])

  useEffect(() => {
    if (walletMode === 'in-browser' && connected) {
      void refreshBalances()
    }
  }, [walletMode, connected, refreshBalances])

  const inBrowserWallet: InBrowserWalletState = useMemo(() => ({
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    solBalance,
    usdcBalance,
    isLoadingBalance,
    isAirdropping,
    statusMessage,
    errorMessage,
    generateNew,
    importSecret,
    exportSecretBase58,
    exportSecretJson,
    requestAirdrop,
    requestUsdcFaucet,
    refreshBalances,
    clearMessages,
  }), [
    keypair,
    solBalance,
    usdcBalance,
    isLoadingBalance,
    isAirdropping,
    statusMessage,
    errorMessage,
    generateNew,
    importSecret,
    exportSecretBase58,
    exportSecretJson,
    requestAirdrop,
    requestUsdcFaucet,
    refreshBalances,
    clearMessages,
  ])

  const activePublicKey = useMemo(() => {
    if (walletMode === 'phantom') return phantomPublicKey
    if (walletMode === 'backpack') return backpackPublicKey
    if (!connected) return undefined
    return walletMode === 'in-browser' ? keypair.publicKey.toBase58() : mockPublicKey
  }, [connected, walletMode, keypair, mockPublicKey, phantomPublicKey, backpackPublicKey])

  const wallet = useMemo<WalletState>(() => ({
    connected: walletMode === 'phantom'
      ? Boolean(phantomPublicKey)
      : walletMode === 'backpack'
        ? Boolean(backpackPublicKey)
        : connected,
    isConnecting,
    phantomAvailable: Boolean(phantomProvider),
    backpackAvailable: Boolean(backpackProvider),
    backpackRpcConfig,
    connectionError,
    walletLabel: walletMode === 'phantom'
      ? 'Phantom'
      : walletMode === 'backpack'
        ? 'Backpack'
        : walletMode === 'mock'
          ? 'Mock wallet'
          : 'ComFi Wallet',
    endpoint,
    publicKey: activePublicKey,
    connect,
    disconnect,
    walletMode,
    setWalletMode,
    inBrowserWallet,
    mockWallet: {
      publicKey: mockPublicKey,
      endpoint,
    },
  }), [
    connected,
    endpoint,
    activePublicKey,
    walletMode,
    inBrowserWallet,
    mockPublicKey,
    isConnecting,
    phantomProvider,
    backpackProvider,
    backpackRpcConfig,
    connectionError,
    connect,
    disconnect,
    setWalletMode,
    phantomPublicKey,
    backpackPublicKey,
  ])

  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error('useWallet must be used inside MockWalletProvider')
  return wallet
}
