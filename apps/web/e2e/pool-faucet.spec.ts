import { expect, test } from '@playwright/test'

for (const scenario of ['server error', 'wrong recipient'] as const) {
  test(`pool funding reports ${scenario} and preserves the selected wallet`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [] } }))
    await page.route('http://127.0.0.1:8899/', route => {
      const { method, id } = route.request().postDataJSON()
      const result = method === 'getHealth' ? 'ok' : method === 'getBalance' ? { context: { slot: 1 }, value: 0 } : { context: { slot: 1 }, value: [] }
      return route.fulfill({ json: { jsonrpc: '2.0', id, result } })
    })
    let recipient = ''
    await page.route('**/__comfi/mock-wallet/fund-wallet', route => {
      const body = route.request().postDataJSON()
      recipient = body.walletAddress
      expect(body.amount).toBe(100)
      return scenario === 'server error'
        ? route.fulfill({ status: 422, json: { error: 'Localnet mint authority unavailable.' } })
        : route.fulfill({ json: { wallet: '11111111111111111111111111111111', signature: 'signature' } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: '⚡ ComFi Wallet', exact: true }).click()
    await page.getByRole('button', { name: /In-Browser Wallet/ }).click()
    const address = (await page.locator('.wallet-pubkey-display').innerText()).trim()
    await page.getByRole('button', { name: '💵 Mint 100 USDC', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(scenario === 'server error' ? 'mint authority unavailable' : 'not confirmed for the selected wallet')
    expect(recipient).toBe(address)
    await expect(page.locator('.wallet-pubkey-display')).toHaveText(address)
    await expect(page.getByText(/Minted 100 test USDC/)).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
