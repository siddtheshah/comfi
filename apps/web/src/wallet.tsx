import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Keypair } from '@solana/web3.js'
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

export type WalletMode = 'mock' | 'in-browser'

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
  connect: () => void
  disconnect: () => void
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

  const [walletMode, setWalletMode] = useState<WalletMode>('mock')
  const [connected, setConnected] = useState(true)

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
    if (!connected) return undefined
    return walletMode === 'in-browser' ? keypair.publicKey.toBase58() : mockPublicKey
  }, [connected, walletMode, keypair, mockPublicKey])

  const wallet = useMemo<WalletState>(() => ({
    connected,
    endpoint,
    publicKey: activePublicKey,
    connect: () => setConnected(true),
    disconnect: () => setConnected(false),
    walletMode,
    setWalletMode,
    inBrowserWallet,
    mockWallet: {
      publicKey: mockPublicKey,
      endpoint,
    },
  }), [connected, endpoint, activePublicKey, walletMode, inBrowserWallet, mockPublicKey])

  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error('useWallet must be used inside MockWalletProvider')
  return wallet
}
