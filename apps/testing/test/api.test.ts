import assert from 'node:assert/strict'
import test from 'node:test'
import { executeAction, formatUsdc } from '../src/backend/localnet.ts'

test('formatUsdc correctly formats atomic USDC amounts', () => {
  assert.equal(formatUsdc('1000000'), '$1.00')
  assert.equal(formatUsdc(10000000), '$10.00')
  assert.equal(formatUsdc(0), '$0.00')
  assert.equal(formatUsdc('25500000'), '$25.50')
  assert.equal(formatUsdc(123456789n), '$123.46')
})

test('formatUsdc rejects invalid atomic inputs rather than evading failures', () => {
  assert.throws(() => {
    formatUsdc('not-a-number')
  })
})

test('executeAction escalates on unknown actions without evading failures', async () => {
  await assert.rejects(
    async () => {
      await executeAction('unknown_action', {})
    },
    { message: /Unknown action: unknown_action/ }
  )
})

test('executeAction escalates on missing required poolAddress parameter for pool operations', async () => {
  await assert.rejects(
    async () => {
      await executeAction('join_pool', { walletName: 'member2' })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('deposit', { walletName: 'creator', amount: 10 })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('set_alias', { walletName: 'creator' })
    },
    { message: /Missing poolAddress/ }
  )

  await assert.rejects(
    async () => {
      await executeAction('roll_cycle', {})
    },
    { message: /Missing poolAddress/ }
  )
})

test('executeAction escalates on invalid wallet names', async () => {
  await assert.rejects(
    async () => {
      await executeAction('fund_wallet', { walletName: 'non_existent_wallet' })
    },
    { message: /Invalid wallet name/ }
  )
})

test('sponsor quote action issues and verifies canonical HMAC quote', async () => {
  const result = await executeAction('sponsor_quote', {
    poolAddress: '11111111111111111111111111111111',
    memberAddress: 'SysvarRent111111111111111111111111111111111',
    action: 'set_alias',
    chargeAtomic: '900',
  })
  assert.equal(result.verified, true)
  assert.equal(result.action, 'set_alias')
  assert.ok(result.signature)
})
