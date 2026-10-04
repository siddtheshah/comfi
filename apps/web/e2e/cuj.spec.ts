import { expect, test, type Page } from '@playwright/test'

async function showTestPool(page: Page) {
  await page.route('**/__comfi/mock-wallet/pools', route => route.fulfill({ json: { pools: [{
    address: 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M',
    id: 0,
    creator: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
    memberCap: 24,
    memberCount: 1,
    balance: '$100.00',
  }] } }))
}

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

test('member can review a pool and begin a proposal', async ({ page }) => {
  await showTestPool(page)
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByRole('heading', { name: 'Community Pool #0' })).toBeVisible()
  await page.getByRole('button', { name: /View proposals/ }).click()
  await expect(page.getByRole('heading', { name: /Bring an idea/ })).toBeVisible()
  await page.getByPlaceholder('e.g. Increase the garden supply limit').fill('Buy a shared tool shed')
  await page.getByPlaceholder('Share the context your community needs to decide.').fill('This keeps supplies dry and shared.')
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByRole('status')).toContainText('Proposal saved for review.')
})

test('member can begin a payment request', async ({ page }) => {
  await showTestPool(page)
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await page.getByRole('button', { name: /Request a payment/ }).click()
  await expect(page.getByRole('heading', { name: 'Payment details' })).toBeVisible()
  await page.getByPlaceholder('0.00').fill('25.00')
  await page.getByPlaceholder('Person or organization').fill('Garden Co-op')
  await page.getByPlaceholder('e.g. Food pantry supplies').fill('Seeds')
  await page.getByPlaceholder('Add any helpful context.').fill('Fall planting supplies')
  await page.getByRole('button', { name: /Review request/ }).click()
  await expect(page.getByRole('status')).toContainText('Payment request saved for review.')
})

test('member can view on-chain pools and inspect smart contract parameters', async ({ page }) => {
  await page.route('**/__comfi/mock-wallet/pools', async route => {
    await route.fulfill({
      json: {
        pools: [
          {
            address: 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M',
            id: 0,
            creator: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
            vault: '2zPrsXu7HHhL8ZVfmzuDsZBQtaZZnjZwwnbGwKpWTD3F',
            memberCap: 24,
            memberCount: 1,
            minimumDepositAtomic: '10000000',
            voteThreshold: 2,
            votingPeriodSeconds: '604800',
            timelockSeconds: '86400',
            currentCycle: '0',
            cycleDurationSeconds: '2592000',
            cycleStartedAt: '1790051252',
            nextRequestId: '0',
            nextProposalId: '0',
            balance: '$100.00',
          },
        ],
      },
    })
  })

  await page.goto('/')
  const poolCard = page.getByTestId('pool-pool-0')
  await expect(poolCard).toBeVisible()
  await expect(page.locator('.pool-card')).toHaveCount(1)
  await expect(page.locator('.side-pools button')).toHaveCount(1)
  await expect(page.locator('.summary-grid article').first()).toContainText('$100.00')
  await expect(poolCard).toContainText('Community Pool #0')
  await expect(poolCard).toContainText('$100.00')
  await expect(poolCard).toContainText('On-chain')

  await poolCard.click()
  await expect(page.getByRole('heading', { name: 'Community Pool #0' })).toBeVisible()
  await expect(page.getByText('On-chain (Localnet)')).toBeVisible()
  await expect(page.getByText('2 affirmative votes')).toBeVisible()
  await expect(page.getByText('$10.00')).toBeVisible()
  await expect(page.getByText('24 members (23 slots open)')).toBeVisible()
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


