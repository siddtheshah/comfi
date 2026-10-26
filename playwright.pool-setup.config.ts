import { defineConfig } from '@playwright/test'

const rpc = process.env.COMFI_POOL_TEST_RPC ?? 'http://127.0.0.1:18899'
export default defineConfig({
  testDir: './apps/web/localnet-e2e', testMatch: 'pool-setup.spec.ts', workers: 1, timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:4176', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined },
  webServer: {
    command: 'npm run dev --workspace=@comfi/web -- --host 127.0.0.1 --port 4176', url: 'http://127.0.0.1:4176', reuseExistingServer: false,
    env: { VITE_SOLANA_RPC: rpc, VITE_SOLANA_NETWORK: 'localnet', VITE_PROGRAM_ID: '3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP', VITE_MOCK_WALLET_PUBLIC_KEY: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB' },
  },
})
