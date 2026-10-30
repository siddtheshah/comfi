import { expect, test, type Page } from '@playwright/test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { poolBytes, poolAddress, creator } from '../test/fixtures/pool'
import { memberAddress, proposalAddress, proposalBytes, memberBytes, programId, withdrawalBytes } from '../test/fixtures/governance'
import { createHash } from 'node:crypto'

const account = (bytes: Buffer) => ({
  data: [bytes.toString('base64'), 'base64'],
  executable: false,
  lamports: 10000000,
  owner: programId,
  rentEpoch: 0,
  space: bytes.length,
})

async function setupPool(page: Page) {
  const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7))
  const walletAddress = creator
  const walletMember = PublicKey.findProgramAddressSync(
    [Buffer.from('member'), new PublicKey(poolAddress).toBuffer(), new PublicKey(walletAddress).toBuffer()],
    new PublicKey(programId)
  )[0].toBase58()

  const member = memberBytes({ next: true, vouch: true })
  new PublicKey(walletAddress).toBuffer().copy(member, 40)

  // A second member (invitee)
  const candidateWallet = 'BVVfYV2AD4KsGWTF3zge1wfH9sb54he1M83UBWazwrNX'
  const secondMemberPda = PublicKey.findProgramAddressSync(
    [Buffer.from('member'), new PublicKey(poolAddress).toBuffer(), new PublicKey(candidateWallet).toBuffer()],
    new PublicKey(programId)
  )[0].toBase58()
  const secondMember = memberBytes()
  new PublicKey(candidateWallet).toBuffer().copy(secondMember, 40)
  secondMember[72] = 0 // Member role
  secondMember[73] = 1 // Funded

  const pool = poolBytes({ locked: false })
  pool.writeUInt32LE(5001, 136)

  const proposals = [proposalBytes(3, 0), proposalBytes(0, 1)]

  await page.addInitScript(
    ({ address, secret }) => {
      Object.assign(window, {
        solana: {
          isPhantom: true,
          connect: async () => ({ publicKey: { toBase58: () => address } }),
          disconnect: async () => {},
          on: () => {},
          removeListener: () => {},
          signTransaction: async () => {
            throw new Error('User rejected transaction.')
          },
        },
        governanceSecret: secret,
      })
    },
    { address: walletAddress, secret: Array.from(keypair.secretKey) }
  )

  await page.route('**/__comfi/mock-wallet/pools', (route) =>
    route.fulfill({
      json: {
        pools: [{ address: poolAddress, data: pool.toString('base64'), vaultBalanceAtomic: '100000000' }],
      },
    })
  )

  await page.route('http://127.0.0.1:8899/', (route) => {
    const { method, params, id } = route.request().postDataJSON()
    let result: unknown

    switch (method) {
      case 'getMultipleAccounts':
        result = {
          context: { slot: 1 },
          value: params[0].map((addr: string) =>
            addr === walletMember ? account(member) : addr === secondMemberPda ? account(secondMember) : null
          ),
        }
        break
      case 'getHealth':
        result = 'ok'
        break
      case 'getAccountInfo':
        result = { context: { slot: 1 }, value: account(pool) }
        break
      case 'getTokenAccountBalance':
        result = { context: { slot: 1 }, value: { amount: '100000000', decimals: 6, uiAmount: 100 } }
        break
      case 'getSlot':
        result = 1
        break
      case 'getBlockTime':
        result = 1790000000
        break
      case 'getLatestBlockhash':
        result = { context: { slot: 1 }, value: { blockhash: creator, lastValidBlockHeight: 1000 } }
        break
      case 'getProgramAccounts': {
        const discriminator = params[1].filters[0].memcmp.bytes
        const encode = (bytes: Buffer) => {
          let n = BigInt('0x' + bytes.toString('hex')),
            s = ''
          const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
          while (n) {
            s = alphabet[Number(n % 58n)] + s
            n /= 58n
          }
          return s
        }
        const disc = (name: string) =>
          encode(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8))

        if (discriminator === disc('Proposal')) {
          result = proposals.map((b, i) => ({
            pubkey: i === 0 ? proposalAddress : PublicKey.findProgramAddressSync([Buffer.from('proposal'), new PublicKey(poolAddress).toBuffer(), Buffer.from([i, 0, 0, 0, 0, 0, 0, 0])], new PublicKey(programId))[0].toBase58(),
            account: account(b),
          }))
        } else if (discriminator === disc('Member')) {
          result = [
            { pubkey: walletMember, account: account(member) },
            { pubkey: secondMemberPda, account: account(secondMember) },
          ]
        } else if (discriminator === disc('WithdrawalRequest')) {
          result = [{ pubkey: proposalAddress, account: account(withdrawalBytes()) }]
        } else {
          result = []
        }
        break
      }
      default:
        return route.fulfill({
          json: { jsonrpc: '2.0', id, error: { code: -32601, message: `Unhandled test RPC: ${method}` } },
        })
    }
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } })
  })

  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
}

test('pool page has all tabs for proposals and people accessible, navigable and interactive', async ({ page }) => {
  await setupPool(page)

  // 1. Verify all tabs exist in the pool tabs navigation
  const tabOverview = page.getByTestId('tab-overview')
  const tabProposals = page.getByTestId('tab-proposals')
  const tabPeople = page.getByTestId('tab-people')
  const tabInvites = page.getByTestId('tab-invites')
  const tabActivity = page.getByTestId('tab-activity')
  const tabRules = page.getByTestId('tab-rules')

  await expect(tabOverview).toBeVisible()
  await expect(tabProposals).toBeVisible()
  await expect(tabPeople).toBeVisible()
  await expect(tabInvites).toBeVisible()
  await expect(tabActivity).toBeVisible()
  await expect(tabRules).toBeVisible()

  // Default tab is overview
  await expect(tabOverview).toHaveClass(/tab-active/)
  await expect(page.getByRole('heading', { name: 'Financial accounting' })).toBeVisible()

  // 2. Click Proposals tab and verify Governance view is displayed
  await tabProposals.click()
  await expect(tabProposals).toHaveClass(/tab-active/)
  await expect(page.getByRole('heading', { name: 'Governance & proposals' })).toBeVisible()
  await expect(page.locator('.governance-proposal')).toHaveCount(2)

  // 3. Click People tab and verify Member Directory & People view
  await tabPeople.click()
  await expect(tabPeople).toHaveClass(/tab-active/)
  const peopleView = page.getByTestId('people-view')
  await expect(peopleView).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Community Members' })).toBeVisible()

  // Verify metric summary cards in People view
  await expect(page.getByText('Active Members')).toBeVisible()
  await expect(page.getByText('Current Funded')).toBeVisible()
  await expect(page.getByText('Matured Voters')).toBeVisible()
  await expect(page.getByText('Paused Rollovers')).toBeVisible()

  // Verify member cards rendered from mock accounts
  await expect(page.locator('.member-card')).toHaveCount(2)
  await expect(page.getByTestId(`member-card-${creator}`)).toBeVisible()
  await expect(page.getByTestId(`member-card-${creator}`).getByText('Matured Voter ✓')).toBeVisible()

  // 4. Test People subnav: Vouch Lineage Tree
  await page.getByTestId('subnav-lineage').click()
  await expect(page.getByTestId('lineage-section')).toBeVisible()
  await expect(page.getByText('Vouch Lineage & Invitation Hierarchy')).toBeVisible()
  await expect(page.getByText('Root & Founding Members')).toBeVisible()

  // 5. Test People subnav: My Membership & Lifecycle Actions
  await page.getByTestId('subnav-actions').click()
  await expect(page.getByTestId('my-membership-section')).toBeVisible()
  await expect(page.getByText('Your Membership Overview')).toBeVisible()
  await expect(page.getByTestId('toggle-pause-btn')).toBeVisible()
  await expect(page.getByTestId('leave-pool-btn')).toBeVisible()

  // 6. Test People subnav: Member Activity & Audit Log
  await page.getByTestId('subnav-audit').click()
  await expect(page.getByTestId('people-audit-section')).toBeVisible()
  await expect(page.getByText('Member Audit & Voting Records')).toBeVisible()

  // 7. Test search filter on directory
  await page.getByTestId('subnav-directory').click()
  const searchInput = page.getByTestId('member-search-input')
  await searchInput.fill(creator.slice(0, 5))
  await expect(page.locator('.member-card')).toHaveCount(1)
  await searchInput.fill('NonexistentAddress')
  await expect(page.getByText('No members found matching your search.')).toBeVisible()
  await searchInput.fill('')

  // 8. Test Right Rail shortcuts: Explore proposals
  await tabOverview.click()
  await expect(tabOverview).toHaveClass(/tab-active/)
  await page.getByTestId('explore-proposals-rail-btn').click()
  await expect(tabProposals).toHaveClass(/tab-active/)
  await expect(page.getByRole('heading', { name: 'Governance & proposals' })).toBeVisible()

  // 9. Test Right Rail shortcuts: Open member directory
  await tabOverview.click()
  await page.getByTestId('open-people-rail-btn').click()
  await expect(tabPeople).toHaveClass(/tab-active/)
  await expect(page.getByRole('heading', { name: 'Community Members' })).toBeVisible()

  // 10. Verify mobile viewport responsiveness
  await page.setViewportSize({ width: 390, height: 844 })
  // Allow sidebar responsive transition (200ms) to settle before checking dimensions and capturing artifact
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/comfi-pool-tabs-mobile.png', fullPage: true })
})
