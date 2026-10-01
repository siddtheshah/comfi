import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backpackAddress,
  BackpackSession,
  getBackpackProvider,
  getBackpackRpcConfig,
  type BackpackProvider,
} from '../src/backpack-wallet.ts'

const key = { toBase58: () => '11111111111111111111111111111111' }
const secondKey = { toBase58: () => 'So11111111111111111111111111111111111111112' }

function fakeProvider(options?: { connectReturnsVoid?: boolean }) {
  const listeners = new Map<string, Set<Function>>()
  const provider: BackpackProvider = {
    isBackpack: true,
    publicKey: key,
    connect: async () => {
      if (options?.connectReturnsVoid) return undefined
      return { publicKey: key }
    },
    disconnect: async () => {},
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener)
    },
  }
  return {
    provider,
    emit: (event: string, value?: unknown) => {
      listeners.get(event)?.forEach(listener => listener(value))
    },
    count: () => [...listeners.values()].reduce((total, entries) => total + entries.size, 0),
  }
}

test('detects dedicated Backpack namespace and window.solana while excluding other providers', () => {
  const { provider } = fakeProvider()
  // Via window.backpack.solana
  assert.equal(getBackpackProvider({ backpack: { solana: provider } }), provider)
  // Via window.backpack directly
  assert.equal(getBackpackProvider({ backpack: provider }), provider)
  // Via window.solana fallback
  assert.equal(getBackpackProvider({ solana: provider }), provider)
  // window.backpack.solana takes precedence over window.solana
  const otherProvider: BackpackProvider = { ...provider, isBackpack: true }
  assert.equal(
    getBackpackProvider({ backpack: { solana: provider }, solana: otherProvider }),
    provider
  )
  // Non-backpack provider is excluded
  assert.equal(getBackpackProvider({ solana: { ...provider, isBackpack: false } }), undefined)
  assert.equal(getBackpackProvider({}), undefined)
})

test('validates extension public keys and rejects missing and malformed addresses', () => {
  assert.equal(backpackAddress(key), key.toBase58())
  assert.throws(() => backpackAddress(null), { message: 'Backpack returned a missing public key.' })
  assert.throws(() => backpackAddress({} as any), { message: 'Backpack returned a missing public key.' })
  assert.throws(() => backpackAddress({ toBase58: () => 'invalid!' }), { message: /Non-base58 character/ })
})

test('getBackpackRpcConfig validates inputs and builds native custom RPC configuration', () => {
  // Escalates on missing or invalid endpoint
  assert.throws(() => getBackpackRpcConfig(''), {
    message: /A valid endpoint string is required for Backpack RPC configuration./,
  })
  assert.throws(() => getBackpackRpcConfig(null as any), {
    message: /A valid endpoint string is required for Backpack RPC configuration./,
  })
  assert.throws(() => getBackpackRpcConfig('   '), {
    message: /A valid endpoint string is required for Backpack RPC configuration./,
  })

  // Localnet configuration
  const local = getBackpackRpcConfig('http://127.0.0.1:8899')
  assert.equal(local.networkName, 'Localnet')
  assert.equal(local.isCustomOrLocalnet, true)
  assert.equal(local.endpoint, 'http://127.0.0.1:8899')
  assert.ok(local.setupSteps.some(s => s.includes('http://127.0.0.1:8899')))

  // Devnet configuration
  const devnet = getBackpackRpcConfig('https://api.devnet.solana.com')
  assert.equal(devnet.networkName, 'Devnet')
  assert.equal(devnet.isCustomOrLocalnet, false)

  // Custom node configuration
  const custom = getBackpackRpcConfig('https://my-custom-rpc.example.com')
  assert.equal(custom.networkName, 'Custom RPC')
  assert.equal(custom.isCustomOrLocalnet, true)
})

test('connects with returned publicKey or provider.publicKey, tracks account changes, disconnects, and removes listeners', async () => {
  const mock = fakeProvider()
  const addresses: Array<string | undefined> = []
  const session = new BackpackSession()
  session.attach(mock.provider, address => addresses.push(address))
  assert.equal(mock.count(), 2)

  // Connect when connect() returns { publicKey }
  await session.connect()
  assert.equal(addresses.at(-1), key.toBase58())

  // Account changed
  mock.emit('accountChanged', secondKey)
  assert.equal(addresses.at(-1), secondKey.toBase58())

  mock.emit('accountChanged', null)
  assert.equal(addresses.at(-1), undefined)

  // Connect when connect() returns void and relies on provider.publicKey
  const mockVoid = fakeProvider({ connectReturnsVoid: true })
  mockVoid.provider.publicKey = secondKey
  const sessionVoid = new BackpackSession()
  sessionVoid.attach(mockVoid.provider, address => addresses.push(address))
  await sessionVoid.connect()
  assert.equal(addresses.at(-1), secondKey.toBase58())
  sessionVoid.detach()

  // Disconnect event
  await session.connect()
  mock.emit('disconnect')
  assert.equal(addresses.at(-1), undefined)

  // Explicit disconnect()
  await session.connect()
  await session.disconnect()
  assert.equal(addresses.at(-1), undefined)

  session.detach()
  assert.equal(mock.count(), 0)
  const count = addresses.length
  mock.emit('accountChanged', secondKey)
  assert.equal(addresses.length, count)
})

test('missing extension, rejected approval, bad response, and failed disconnect explicitly reject', async () => {
  const session = new BackpackSession()
  session.attach(undefined, () => {})
  await assert.rejects(() => session.connect(), { message: /Backpack is not installed/ })
  await assert.rejects(() => session.disconnect(), { message: /Backpack is not installed/ })

  const { provider } = fakeProvider()
  session.attach(provider, () => {})

  provider.connect = async () => {
    throw new Error('User rejected the request.')
  }
  await assert.rejects(() => session.connect(), { message: 'User rejected the request.' })

  provider.connect = async () => ({ publicKey: null as any })
  provider.publicKey = null
  await assert.rejects(() => session.connect(), { message: 'Backpack returned a missing public key.' })

  provider.disconnect = async () => {
    throw new Error('Backpack disconnect failed.')
  }
  await assert.rejects(() => session.disconnect(), { message: 'Backpack disconnect failed.' })

  session.detach()
})

test('late approval cannot reconnect after mode change, unmount, revocation, or a newer request', async () => {
  for (const cancel of ['detach', 'accountChanged', 'disconnect', 'newerRequest']) {
    const mock = fakeProvider()
    const addresses: Array<string | undefined> = []
    const session = new BackpackSession()
    session.attach(mock.provider, address => addresses.push(address))
    let approve!: (value: { publicKey: typeof key }) => void
    mock.provider.connect = () => new Promise(resolve => {
      approve = resolve
    })
    const pending = session.connect()
    if (cancel === 'detach') session.detach()
    else if (cancel === 'newerRequest') {
      mock.provider.connect = async () => ({ publicKey: secondKey })
      await session.connect()
    } else mock.emit(cancel, null)
    const beforeApproval = [...addresses]
    approve({ publicKey: key })
    await pending
    assert.deepEqual(addresses, beforeApproval)
    session.detach()
  }
})

test('reattaching a session never accumulates extension listeners', () => {
  const first = fakeProvider()
  const second = fakeProvider()
  const session = new BackpackSession()
  session.attach(first.provider, () => {})
  session.attach(first.provider, () => {})
  assert.equal(first.count(), 2)
  session.attach(second.provider, () => {})
  assert.equal(first.count(), 0)
  assert.equal(second.count(), 2)
  session.detach()
  assert.equal(second.count(), 0)
})
