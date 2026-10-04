import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'

function pool(id: number) {
  const data = Buffer.alloc(206)
  data.writeBigUInt64LE(BigInt(id), 40)
  data.writeUInt32LE(24, 112)
  data.writeUInt32LE(1, 116)
  return { pubkey: '11111111111111111111111111111111', account: { data: [data.toString('base64'), 'base64'] } }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [] } }))
  await page.route('**/api.*net.solana.com/**', async route => {
    const method = route.request().postDataJSON().method
    const result = method === 'getHealth' ? 'ok' : method === 'getProgramAccounts' ? [pool(42)] : { value: { uiAmountString: '1.00' } }
    await route.fulfill({ json: { result } })
  })
  await page.route('http://127.0.0.1:8899/', route => route.fulfill({ json: { result: 'ok' } }))
})

test('network switch updates pool reads, labels, health, and guards localnet signer actions', async ({ page }) => {
  let mockActions = 0
  await page.route('**/__comfi/mock-wallet/create-pool', route => { mockActions++; return route.abort() })
  await page.goto('/')
  await expect(page.getByTestId('rpc-health')).toHaveText('Online')
  await page.getByLabel('Solana network', { exact: true }).selectOption('devnet')
  await expect(page.getByTestId('localnet-wallet')).toContainText('Devnet')
  await expect(page.getByTestId('localnet-wallet')).toContainText('https://api.devnet.solana.com')
  await expect(page.getByTestId('pool-pool-42')).toBeVisible()
  await page.getByTestId('pool-pool-42').click()
  await expect(page.getByText('On-chain (Devnet)', { exact: true })).toBeVisible()
  await page.getByLabel('Solana network', { exact: true }).selectOption('testnet')
  await expect(page.getByTestId('localnet-wallet')).toContainText('https://api.testnet.solana.com')
  await page.getByTestId('start-pool').click()
  await expect(page.getByRole('status')).toContainText('requires the configured localnet RPC')
  expect(mockActions).toBe(0)
  await page.screenshot({ path: '/tmp/comfi-networks-verification/networks.png', fullPage: true })
})

test('custom RPC validation, failure health, and network-specific saved endpoints', async ({ page }) => {
  await page.route('https://custom.example/rpc', route => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.goto('/')
  await page.getByText('RPC settings', { exact: true }).click()
  await page.getByLabel('RPC URL', { exact: true }).fill('ftp://example.com')
  await page.getByRole('button', { name: 'Apply RPC' }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP or HTTPS RPC URL')
  await page.getByLabel('RPC URL', { exact: true }).fill('https://custom.example/rpc')
  await page.getByRole('button', { name: 'Apply RPC' }).click()
  await expect(page.getByTestId('rpc-health')).toHaveText('Offline')
  await expect(page.locator('.rpc-settings-card')).toContainText('RPC returned HTTP 503.')
  await expect(page.locator('.pool-error')).toContainText('Solana RPC returned status 503')
  await page.getByLabel('Solana network', { exact: true }).selectOption('devnet')
  await expect(page.getByTestId('rpc-health')).toHaveText('Online')
  await page.getByLabel('Solana network', { exact: true }).selectOption('localnet')
  await expect(page.getByLabel('RPC URL', { exact: true })).toHaveValue('https://custom.example/rpc')
  await page.screenshot({ path: '/tmp/comfi-networks-verification/offline.png', fullPage: true })
})

test('late pool responses from the previous network do not replace the current pool list', async ({ page }) => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  await page.route('https://api.devnet.solana.com/', async route => {
    if (route.request().postDataJSON().method !== 'getProgramAccounts') return route.fulfill({ json: { result: 'ok' } })
    started()
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { result: [pool(9)] } })
  })
  await page.goto('/')
  await page.getByLabel('Solana network', { exact: true }).selectOption('devnet')
  await pending
  await page.getByLabel('Solana network', { exact: true }).selectOption('testnet')
  await expect(page.getByTestId('pool-pool-42')).toBeVisible()
  const oldResponse = page.waitForResponse(response => response.url().includes('api.devnet') && response.request().postDataJSON().method === 'getProgramAccounts')
  release()
  await oldResponse
  await expect(page.getByTestId('pool-pool-42')).toBeVisible()
  await expect(page.getByTestId('pool-pool-9')).toHaveCount(0)
})

test('navbar network controls and RPC settings fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByText('RPC settings', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply RPC' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/comfi-networks-verification/mobile.png', fullPage: true })
})

test('balance refresh uses the selected RPC and ignores a late previous-network balance', async ({ page }) => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  await page.route('http://127.0.0.1:8899/', route => {
    const method = route.request().postDataJSON().method
    const result = method === 'getHealth' ? 'ok' : method === 'getBalance' ? { value: 5_000_000_000 } : { value: [] }
    return route.fulfill({ json: { result } })
  })
  await page.route('https://api.devnet.solana.com/', async route => {
    const method = route.request().postDataJSON().method
    if (method === 'getBalance') {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return route.fulfill({ json: { result: { value: 9_000_000_000 } } })
    }
    return route.fulfill({ json: { result: method === 'getHealth' ? 'ok' : method === 'getProgramAccounts' ? [] : { value: [] } } })
  })
  await page.route('https://api.testnet.solana.com/', route => {
    const method = route.request().postDataJSON().method
    const result = method === 'getHealth' ? 'ok' : method === 'getBalance' ? { value: 2_000_000_000 } : method === 'getProgramAccounts' ? [] : { value: [] }
    return route.fulfill({ json: { result } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: '⚡ In-Browser Wallet', exact: true }).click()
  await expect(page.getByText('5.0000 SOL', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByLabel('Solana network', { exact: true }).selectOption('devnet')
  await pending
  await page.getByLabel('Solana network', { exact: true }).selectOption('testnet')
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await expect(page.getByText('2.0000 SOL', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '💵 Mint 100 USDC', exact: true })).toBeDisabled()
  const oldResponse = page.waitForResponse(response => response.url().includes('api.devnet') && response.request().postDataJSON().method === 'getBalance')
  release()
  await oldResponse
  await expect(page.getByText('2.0000 SOL', { exact: true })).toBeVisible()
  await expect(page.getByText('9.0000 SOL', { exact: true })).toHaveCount(0)
})


test('the public USDC faucet action rejects other networks and custom localnet without a request', async ({ page }) => {
  let faucetRequests = 0
  await page.route('**/api/action', route => { faucetRequests++; return route.abort() })
  await page.goto('/')
  await page.evaluate(async () => {
    // Render a consumer of the public wallet API in a separate test-only root.
    const walletSource = await (await fetch('/src/wallet.tsx')).text()
    const mainSource = await (await fetch('/src/main.tsx')).text()
    const reactUrl = walletSource.match(/"([^"\n]*\/react\.js[^"\n]*)"/)![1]
    const rootUrl = mainSource.match(/"([^"\n]*\/react-dom_client\.js[^"\n]*)"/)![1]
    const { default: React } = await import(reactUrl)
    const { default: ReactDOM } = await import(rootUrl)
    const walletModuleUrl = '/src/wallet.tsx'
    const { MockWalletProvider, useWallet } = await import(walletModuleUrl)
    const element = document.createElement('div')
    document.body.appendChild(element)
    function Harness() { (window as any).testWallet = useWallet(); return null }
    ;(window as any).testWalletRoot = ReactDOM.createRoot(element)
    ;(window as any).testWalletRoot.render(React.createElement(MockWalletProvider, null, React.createElement(Harness)))
  })
  await page.waitForFunction(() => Boolean((window as any).testWallet))
  for (const network of ['devnet', 'testnet']) {
    await page.evaluate(value => { (window as any).testWallet.setNetwork(value) }, network)
    await page.waitForFunction(value => (window as any).testWallet.network === value, network)
    await assert.rejects(() => page.evaluate(() => (window as any).testWallet.inBrowserWallet.requestUsdcFaucet(100)), {
      message: /The test USDC faucet requires the configured localnet RPC\./,
    })
  }
  await page.evaluate(() => { (window as any).testWallet.setNetwork('localnet') })
  await page.waitForFunction(() => (window as any).testWallet.network === 'localnet')
  await page.evaluate(() => { (window as any).testWallet.setRpcEndpoint('http://127.0.0.1:9900') })
  await page.waitForFunction(() => (window as any).testWallet.endpoint === 'http://127.0.0.1:9900')
  await assert.rejects(() => page.evaluate(() => (window as any).testWallet.inBrowserWallet.requestUsdcFaucet(100)), {
    message: /The test USDC faucet requires the configured localnet RPC\./,
  })
  expect(faucetRequests).toBe(0)
  await page.evaluate(() => { (window as any).testWalletRoot.unmount() })
})
