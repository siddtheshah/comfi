import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import './styles.css'
import { App } from './App'
import { MockWalletProvider } from './wallet'

if (typeof window !== 'undefined' && !('Buffer' in window)) {
  ;(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><MockWalletProvider><App /></MockWalletProvider></StrictMode>,
)
