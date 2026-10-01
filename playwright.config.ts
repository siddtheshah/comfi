import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './apps/web/e2e',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run dev --workspace=@comfi/web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    env: {
      VITE_WALLET_MODE: 'mock',
      VITE_SOLANA_RPC: 'http://127.0.0.1:8899',
      VITE_PROGRAM_ID: '3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP',
      VITE_MOCK_WALLET_PUBLIC_KEY: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
    },
  },
})
