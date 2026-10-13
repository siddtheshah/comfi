import { defineConfig } from '@playwright/test'

// Requires `npm run user-account:localnet` in a separate terminal.
export default defineConfig({
  testDir: './apps/web/localnet-e2e',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: 'npm run dev --workspace=@comfi/web -- --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    env: {
      VITE_SOLANA_RPC: 'http://127.0.0.1:18899',
      VITE_SOLANA_NETWORK: 'localnet',
      VITE_PROGRAM_ID: '3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP',
      VITE_MOCK_WALLET_PUBLIC_KEY: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
    },
  },
})
