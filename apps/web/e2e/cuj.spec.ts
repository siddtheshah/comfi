import { expect, test, type Page } from '@playwright/test'

import { poolAddress, poolBytes } from '../test/fixtures/pool'

async function showTestPool(page: Page, options: Parameters<typeof poolBytes>[0] = {}) {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [{
    address: poolAddress,
    data: poolBytes(options).toString('base64'),
    vaultBalanceAtomic: '100000000',
  }] } }))
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [] } }))
  await page.route('http://127.0.0.1:8899/', route => {
    const method = route.request().postDataJSON().method
    const result = method === 'getHealth' ? 'ok' : method === 'getBalance' ? { value: 0 } : method === 'getProgramAccounts' ? [] : { value: [] }
    return route.fulfill({ json: { result } })
  })
})

test('an empty network shows no default pools or demo filter', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('pool-empty-state')).toContainText('No pools found on Localnet.')
  await expect(page.locator('.pool-card')).toHaveCount(0)
  await expect(page.locator('.side-pools button')).toHaveCount(0)
  await expect(page.getByText(/Maple Street Mutual Aid|Eastside Community Garden|Room 204 Family Fund/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Demo', exact: true })).toHaveCount(0)
  await expect(page.locator('.summary-grid article').first()).toContainText('$0.00')
})

test('localnet mock wallet exposes the selected test identity', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('localnet-wallet')).toContainText('Localnet mock wallet connected')
  await expect(page.getByTestId('wallet-status')).toContainText('Mock wallet')
})

test('mock wallet deploys a pool through the local development endpoint', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/create-pool', async route => {
    await route.fulfill({ json: { pool: 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M' } })
  })
  await page.goto('/')
  await page.getByTestId('create-pool').click()
  await expect(page.getByRole('status')).toContainText('Pool deployed on localnet: H3hT…pm9M.')
})

test('mock wallet can initialize the localnet deployer before pool creation', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/initialize', async route => {
    await route.fulfill({ json: { global: 'BVVfYV2AD4KsGWTF3zge1wfH9sb54he1M83UBWazwrNX' } })
  })
  await page.goto('/')
  await page.getByTestId('initialize-localnet').click()
  await expect(page.getByRole('status')).toContainText('Localnet deployer initialized: BVVf…wrNX.')
})

test('pool displays live metrics and contains no fabricated activity or actions', async ({ page }) => {
  await showTestPool(page)
  await page.goto('/')
  const poolCard = page.getByTestId('pool-pool-0')
  await expect(poolCard).toContainText('$100.00')
  await expect(poolCard).toContainText('Locked · Cycle 9')
  await expect(poolCard).toContainText('5 proposals created')
  await poolCard.click()
  await expect(page.getByRole('heading', { name: 'Financial accounting' })).toBeVisible()
  await expect(page.getByText('2 affirmative votes')).toBeVisible()
  await expect(page.getByText('$10.00', { exact: true })).toBeVisible()
  await expect(page.getByText('$9,007,199,254.74', { exact: true })).toBeVisible()
  await expect(page.getByText('1 / 4 (25.00%)', { exact: true })).toBeVisible()
  await expect(page.getByText('50.01%', { exact: true })).toBeVisible()
  await expect(page.getByText('InviteVouched', { exact: true })).toBeVisible()
  await expect(page.getByText('2 funded cycles', { exact: true })).toBeVisible()
  await expect(page.getByText('Auto-close after 1 more consecutive locked cycles.')).toBeVisible()
  await expect(page.getByText('Activity history is not connected yet.')).toBeVisible()
  await expect(page.getByText(/Yasmine|Maya|Jordan|August contribution/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /View proposals|Request a payment|Add money/ })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/comfi-metrics-desktop.png', fullPage: true })
})

test('closing pool shows closure accounting and pending admission rules', async ({ page }) => {
  await showTestPool(page, { closing: true, locked: false, pending: true, open: true })
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByText(/Pool closing. New deposits/)).toBeVisible()
  await expect(page.getByText('Closure vault basis', { exact: true })).toBeVisible()
  await expect(page.getByText('Pending voting maturation: 3 cycles')).toBeVisible()
  await expect(page.getByText('Pending admission mode: Open')).toBeVisible()
  await expect(page.getByText(/Auto-close after/)).toHaveCount(0)
})

test('legacy pool metrics stay unavailable', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [{
    address: poolAddress, data: poolBytes().subarray(0, 289).toString('base64'), vaultBalanceAtomic: '100000000',
  }] } }))
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByText(/This pool uses a legacy account layout/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Financial accounting' })).toHaveCount(0)
})

test('malformed account data surfaces a load error', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [{
    address: poolAddress, data: poolBytes().subarray(0, 300).toString('base64'), vaultBalanceAtomic: '100000000',
  }] } }))
  await page.goto('/')
  await expect(page.locator('.pool-error')).toContainText('Truncated pool metrics')
  await expect(page.locator('.pool-card')).toHaveCount(0)
})

test('pool metrics fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await showTestPool(page)
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByRole('heading', { name: 'Quorum health' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/comfi-metrics-mobile.png', fullPage: true })
})

test('Copilot uses decoded metrics and has no fabricated proposals or execution claims', async ({ page }) => {
  await showTestPool(page)
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await page.getByTestId('copilot-toggle-btn').click()
  await page.getByRole('button', { name: /Pool Insights/ }).click()
  await expect(page.getByText('Duration: 2592000 seconds')).toBeVisible()
  await expect(page.getByText('Proposal lifecycle integration is pending.')).toBeVisible()
  await expect(page.getByText('Authorize cycle budget')).toHaveCount(0)
  await page.getByRole('button', { name: /Assistant/, exact: false }).click()
  const input = page.getByPlaceholder('Ask Copilot about quorum, proposals, cycle renewals…')
  await input.fill('What is our quorum status?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(/Funded participation: 1 \/ 4 \(25.00%\)/)).toBeVisible()
  await input.fill('Execute passed proposals')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(/No transaction has been submitted/)).toBeVisible()
  for (const query of ['What is pending?', 'Crank', 'Run']) {
    await input.fill(query)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Proposals, member refunds, and transaction signing are not connected yet. No transaction has been submitted.', { exact: true }).last()).toBeVisible()
  }
  await expect(page.getByText(/There are currently no active or pending proposals|No executable proposals found/)).toHaveCount(0)
  await expect(page.locator('.copilot-action-exec-btn')).toHaveCount(0)
  await page.getByRole('button', { name: /Autonomy & Risk/ }).click()
  await page.getByText('Tier 3: Autonomous Delegation', { exact: true }).click()
  await expect(page.getByText('Automation is unavailable until transaction signing is connected.')).toBeVisible()
  await expect(page.locator('.copilot-tier-card.selected')).toContainText('Tier 1: Advisory Mode')
})

test('user can open ComFi in-browser wallet manager, switch modes, and manage keys', async ({ page }) => {
  await page.goto('/')

  // Open wallet modal via quick button
  await page.getByRole('button', { name: /ComFi Wallet/i }).click()
  await expect(page.getByRole('heading', { name: 'ComFi Wallet Manager' })).toBeVisible()

  // Switch to in-browser wallet tab
  await page.getByRole('button', { name: /In-Browser Wallet/i }).click()
  await expect(page.getByText('Active Wallet Address')).toBeVisible()
  await expect(page.getByText('SOL Balance')).toBeVisible()
  await expect(page.getByText('USDC Balance')).toBeVisible()

  // Test copy address
  await page.getByRole('button', { name: /Copy Address/i }).click()
  await expect(page.getByRole('button', { name: /Copied/i })).toBeVisible()

  // Test export secret key
  await page.getByRole('button', { name: /Export Secret Key/i }).click()
  await expect(page.getByText('Base58 Private Key')).toBeVisible()
  await expect(page.getByText('JSON Array Format')).toBeVisible()

  // Test generate new keypair
  await page.getByRole('button', { name: /1-Click New Keypair/i }).click()
  await expect(page.getByRole('button', { name: /Confirm Overwrite/i })).toBeVisible()
  await page.getByRole('button', { name: /Confirm Overwrite/i }).click()
  await expect(page.getByText('New in-browser wallet generated successfully!')).toBeVisible()

  // Close modal
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('heading', { name: 'ComFi Wallet Manager' })).not.toBeVisible()

  // Verify banner reflects in-browser wallet
  await expect(page.getByTestId('localnet-wallet')).toContainText('ComFi In-Browser wallet connected')
})

test('user can open Create Pool modal and configure admission mode, obligation, and quorum parameters', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/create-pool', async route => {
    await route.fulfill({ json: { pool: 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M' } })
  })
  await page.goto('/')

  // Click customize pool button
  await page.getByTestId('open-create-pool').click()
  await expect(page.getByRole('heading', { name: 'Create a Community Pool' })).toBeVisible()

  // Verify admission mode toggles
  await expect(page.getByTestId('mode-invite-vouched')).toBeVisible()
  await expect(page.getByTestId('mode-open')).toBeVisible()
  await page.getByTestId('mode-open').click()
  await expect(page.getByTestId('mode-open')).toHaveClass(/selected/)

  // Switch back to InviteVouched
  await page.getByTestId('mode-invite-vouched').click()
  await expect(page.getByTestId('mode-invite-vouched')).toHaveClass(/selected/)

  // Change parameters
  await page.getByTestId('create-pool-obligation-input').fill('25')
  await page.getByTestId('create-pool-min-deposit-input').fill('50')
  await page.getByTestId('create-pool-duration-select').selectOption('14')
  await page.getByTestId('create-pool-cap-input').fill('36')
  await page.getByTestId('create-pool-threshold-select').selectOption('6000')
  await page.getByTestId('create-pool-min-members-input').fill('3')

  // Submit modal
  await page.getByTestId('create-pool-modal-submit').click()
  await expect(page.getByRole('status')).toContainText('Pool deployed on localnet: H3hT…pm9M.')
  await expect(page.getByRole('heading', { name: 'Create a Community Pool' })).not.toBeVisible()
})

test('member can invite candidates, generate sharable payload, and track invitations', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await showTestPool(page)
  await page.goto('/')

  // Enter test pool
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByRole('heading', { name: 'Community Pool #0' })).toBeVisible()

  // Open invite modal via hero button
  await page.getByTestId('invite-members-hero-btn').click()
  await expect(page.getByRole('heading', { name: 'Invite New Member' })).toBeVisible()

  // Fill in candidate information
  await page.getByTestId('invitee-name-field').fill('Maya S.')
  await page.getByTestId('invitee-note-field').fill('Welcome to our mutual aid pool!')

  // Generate invitation
  await page.getByTestId('generate-invite-submit').click()
  await expect(page.getByRole('heading', { name: 'Invitation Ready to Share' })).toBeVisible()

  // Verify sharable URL and email message generated
  const shareInput = page.getByTestId('share-url-input')
  await expect(shareInput).toBeVisible()
  const shareUrl = await shareInput.inputValue()
  expect(shareUrl).toContain('?invite=')

  await expect(page.getByTestId('email-message-textarea')).toContainText('Maya S.')
  await expect(page.getByTestId('email-message-textarea')).toContainText('AdmitMember governance proposal')

  // Copy link and message
  await page.getByTestId('copy-invite-link').click()
  await expect(page.getByText('Copied link to clipboard!')).toBeVisible()

  await page.getByTestId('copy-invite-email').click()
  await expect(page.getByText('Copied message to clipboard!')).toBeVisible()

  // Close invite modal
  await page.getByTestId('invite-done-btn').click()

  // Verify invitation appears in the tracking card
  const trackingCard = page.getByTestId('invite-tracking-card')
  await expect(trackingCard).toBeVisible()
  await expect(trackingCard.getByText('Maya S.')).toBeVisible()
  await expect(trackingCard.getByText('Pending Recipient')).toBeVisible()

  // Test recipient acceptance simulation via tracking card
  await page.getByTestId('simulate-accept-btn').click()
  await expect(page.getByRole('heading', { name: 'Join Community Pool' })).toBeVisible()

  // Use connected wallet
  await page.getByTestId('recipient-wallet-input').fill('BVVfYV2AD4KsGWTF3zge1wfH9sb54he1M83UBWazwrNX')
  await page.getByTestId('accept-invite-submit').click()

  // Verify automated webhook execution step
  await expect(page.getByRole('heading', { name: 'Wallet Submitted & Proposal Dispatched!' })).toBeVisible()
  await expect(page.getByText('Automated Webhook Triggered')).toBeVisible()
  await expect(page.getByText(/AdmitMember Governance Proposal Dispatched/)).toBeVisible()

  // Close success modal
  await page.getByTestId('close-success-btn').click()

  // Verify tracking card shows proposal queued and allows admission execution
  await expect(trackingCard.getByText(/Proposal #\d+ Queued/)).toBeVisible()
  await expect(page.getByTestId('execute-admit-btn')).toBeVisible()

  // Execute admission
  await page.getByTestId('execute-admit-btn').click()
  await expect(page.getByText(/admitted successfully!/i)).toBeVisible()
  await expect(trackingCard.locator('.admitted-check-tag')).toBeVisible()
})



