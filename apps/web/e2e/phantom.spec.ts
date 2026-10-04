import { expect, test } from '@playwright/test'

const address = '11111111111111111111111111111111'
const secondAddress = 'So11111111111111111111111111111111111111112'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(key: unknown) => void>>()
    const emit = (event: string, value?: unknown) => listeners.get(event)?.forEach(listener => listener(value))
    Object.assign(window, {
      solana: {
        isPhantom: true,
        connect: async () => ({ publicKey: { toBase58: () => '11111111111111111111111111111111' } }),
        disconnect: async () => { emit('disconnect') },
        on: (event: string, listener: (key: unknown) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)!.add(listener)
        },
        removeListener: (event: string, listener: (key: unknown) => void) => { listeners.get(event)?.delete(listener) },
      },
      emitPhantom: emit,
    })
  })
})

test('Phantom connection tracks the extension account and disconnect; mock actions are guarded', async ({ page }) => {
  let mockRequests = 0
  await page.route('**/__comfi/mock-wallet/create-pool', route => { mockRequests++; return route.abort() })
  await page.goto('/')
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  await expect(page.getByText('Connect a wallet to see its address.')).toBeVisible()
  await expect(page.getByText(/Developer Settings → Change Network/)).toBeVisible()
  await page.getByRole('button', { name: 'Connect Phantom', exact: true }).click()
  await expect(page.getByTestId('wallet-status')).toContainText('Phantom · 1111…1111')
  await expect(page.getByText(address, { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/comfi-phantom-verification/connected.png', fullPage: true })
  await page.evaluate(value => {
    (window as any).emitPhantom('accountChanged', { toBase58: () => value })
  }, secondAddress)
  await expect(page.getByTestId('wallet-status')).toContainText('So11…1112')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByTestId('wallet-status')).toHaveCount(0)
  await page.getByRole('button', { name: 'Connect Phantom', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByTestId('start-pool').click()
  await expect(page.getByRole('status')).toContainText('Select and connect the mock wallet')
  expect(mockRequests).toBe(0)
})

test('rejected approval is visible and does not report a connected Phantom wallet', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => { (window as any).solana.connect = async () => { throw new Error('User rejected the request.') } })
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  await page.getByRole('button', { name: 'Connect Phantom', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('User rejected the request.')
  await expect(page.getByTestId('wallet-status')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/comfi-phantom-verification/rejected.png', fullPage: true })
})

test('missing extension offers installation guidance and disables connection', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => { delete (window as any).solana })
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Phantom', exact: true })).toHaveAttribute('href', 'https://phantom.com/download')
  await expect(page.getByRole('button', { name: 'Connect Phantom', exact: true })).toBeDisabled()
  await page.screenshot({ path: '/tmp/comfi-phantom-verification/missing.png', fullPage: true })
})

test('switching wallet modes during approval ignores a late Phantom response', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    (window as any).solana.connect = () => new Promise(resolve => {
      (window as any).approvePhantom = () => resolve({ publicKey: { toBase58: () => '11111111111111111111111111111111' } })
    })
  })
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  await page.getByRole('button', { name: 'Connect Phantom', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '🧪 Mock Test Identity', exact: true }).click()
  await page.evaluate(() => { (window as any).approvePhantom() })
  await expect(page.getByTestId('wallet-status')).toContainText('Mock wallet')
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  await expect(page.getByText('Connect a wallet to see its address.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Phantom', exact: true })).toBeEnabled()
})

test('Phantom guidance and wallet controls fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Phantom', exact: true }).click()
  const card = page.locator('.wallet-modal-card')
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/comfi-phantom-verification/mobile.png', fullPage: true })
})
