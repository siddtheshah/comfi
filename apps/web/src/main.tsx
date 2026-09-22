import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { MockWalletProvider } from './wallet'

createRoot(document.getElementById('root')!).render(
  <StrictMode><MockWalletProvider><App /></MockWalletProvider></StrictMode>,
)
