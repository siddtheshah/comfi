import { createContext, type PropsWithChildren, useContext, useMemo, useState } from 'react'

function requireEnv(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Configure it in .env.`)
  }
  return value
}

type WalletState = { connected: boolean; endpoint: string; publicKey?: string; connect: () => void; disconnect: () => void }
const WalletContext = createContext<WalletState | undefined>(undefined)

export function MockWalletProvider({ children }: PropsWithChildren) {
  const endpoint = requireEnv('VITE_SOLANA_RPC', import.meta.env.VITE_SOLANA_RPC)
  const publicKey = requireEnv('VITE_MOCK_WALLET_PUBLIC_KEY', import.meta.env.VITE_MOCK_WALLET_PUBLIC_KEY)
  const [connected, setConnected] = useState(true)
  const wallet = useMemo<WalletState>(() => ({
    connected,
    endpoint,
    publicKey: connected ? publicKey : undefined,
    connect: () => setConnected(true),
    disconnect: () => setConnected(false),
  }), [connected, endpoint, publicKey])
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

export function useWallet() {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error('useWallet must be used inside MockWalletProvider')
  return wallet
}
