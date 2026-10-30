import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'

test('create, reload, and update a passcode-authenticated UserAccount on the real localnet', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'User account', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Connect a base wallet')
  await page.getByRole('button', { name: 'Use ComFi base wallet' }).click()
  await expect(page.getByRole('button', { name: 'Create UserAccount', exact: true })).toBeEnabled()

  // Only test SOL is provided externally; creation/signing/confirmation/readback
  // all run through the app and the deployed program without mocked endpoints.
  const address = (await page.locator('.account-base code').textContent())!.trim()
  const connection = new Connection('http://127.0.0.1:18899', 'confirmed')
  const funding = await connection.requestAirdrop(new PublicKey(address), 2_000_000_000)
  await expect.poll(async () => (await connection.getSignatureStatuses([funding])).value[0]?.confirmationStatus).toMatch(/confirmed|finalized/)

  const passcode = 'localnet account test passcode'
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByLabel('Confirm passcode', { exact: true }).fill('another passcode')
  await expect(page.getByLabel('Browser passcode', { exact: true })).toHaveValue(passcode)
  await expect(page.getByLabel('Confirm passcode', { exact: true })).toHaveValue('another passcode')
  await page.getByRole('button', { name: 'Create UserAccount', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Passcodes do not match')
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByLabel('Confirm passcode', { exact: true }).fill(passcode)
  await page.getByRole('button', { name: 'Create UserAccount', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('UserAccount created and verified', { timeout: 30_000 })
  const user = await page.getByTestId('user-account-address').innerText()
  await expect(page.getByTestId('user-account-sequence')).toHaveText('1')
  await expect(page.getByLabel('Browser passcode', { exact: true })).toHaveValue('')
  const saved = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('comfi:user-account:v1:')))
  expect(saved).toBeDefined()
  expect(saved![1]).not.toContain(passcode)
  expect(saved![1]).not.toContain('privateKey')

  // Log out of the loaded UserAccount and verify state resets
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Logged out of UserAccount')
  await expect(page.getByTestId('user-account-address')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Load account', exact: true })).toBeVisible()

  // Attempt loading with a wrong passcode while logged out
  await page.getByLabel('Browser passcode', { exact: true }).fill('wrong account passcode')
  await page.getByRole('button', { name: 'Load account', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect passcode')
  expect(await page.evaluate(key => localStorage.getItem(key), saved![0])).toBe(saved![1])

  // Log back in with the correct passcode
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByRole('button', { name: 'Load account', exact: true }).click()
  await expect(page.getByTestId('user-account-address')).toHaveText(user)
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'User account', exact: true }).click()
  await page.getByRole('button', { name: 'Use ComFi base wallet' }).click()
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByRole('button', { name: 'Load account', exact: true }).click()
  await expect(page.getByTestId('user-account-address')).toHaveText(user)

  const label = 'My first ComFi profile'
  await page.getByLabel('Profile label', { exact: true }).fill(label)
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByRole('button', { name: 'Send test update', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Profile reference updated and verified', { timeout: 30_000 })
  const hash = createHash('sha256').update(label).digest('hex')
  await expect(page.getByTestId('user-account-profile')).toHaveText(hash)
  await expect(page.getByTestId('user-account-sequence')).toHaveText('2')
  const onChain = await connection.getAccountInfo(new PublicKey(user))
  expect(onChain!.data.subarray(69, 101).toString('hex')).toBe(hash)
  await page.screenshot({ path: '/tmp/comfi-user-account-ui.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: '/tmp/comfi-user-account-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  // Recovery preserves the stable identity and checks the wallet/chain binding.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(key => localStorage.removeItem(key), saved![0])
  await page.getByRole('button', { name: 'My pools', exact: true }).click()
  await page.getByRole('button', { name: 'User account', exact: true }).click()
  const restore = page.getByLabel('Restore encrypted backup', { exact: true })
  await restore.setInputFiles({ name: 'wrong-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ storageKey: 'other-wallet', credential: JSON.parse(saved![1]) })) })
  await expect(page.getByRole('alert')).toContainText('different base wallet or localnet')
  expect(await page.evaluate(key => localStorage.getItem(key), saved![0])).toBeNull()
  await restore.setInputFiles({ name: 'account-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ storageKey: saved![0], credential: JSON.parse(saved![1]) })) })
  await expect(page.getByRole('status')).toContainText('Encrypted backup restored')
  await page.getByLabel('Browser passcode', { exact: true }).fill(passcode)
  await page.getByRole('button', { name: 'Load account', exact: true }).click()
  await expect(page.getByTestId('user-account-address')).toHaveText(user)
  await expect(page.getByTestId('user-account-sequence')).toHaveText('2')
  await expect(page.getByTestId('user-account-profile')).toHaveText(hash)
})
