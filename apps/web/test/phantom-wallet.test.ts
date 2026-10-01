import assert from 'node:assert/strict'
import test from 'node:test'
import { getPhantomProvider, phantomAddress, PhantomSession, type PhantomProvider } from '../src/phantom-wallet.ts'

const key = { toBase58: () => '11111111111111111111111111111111' }
const secondKey = { toBase58: () => 'So11111111111111111111111111111111111111112' }
function fakeProvider() {
  const listeners = new Map<string, Set<Function>>()
  const provider: PhantomProvider = {
    isPhantom: true,
    connect: async () => ({ publicKey: key }),
    disconnect: async () => {},
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener) },
  }
  return {
    provider,
    emit: (event: string, value?: unknown) => { listeners.get(event)?.forEach(listener => listener(value)) },
    count: () => [...listeners.values()].reduce((total, entries) => total + entries.size, 0),
  }
}

test('detects dedicated Phantom namespace and window.solana while excluding other providers', () => {
  const { provider } = fakeProvider()
  assert.equal(getPhantomProvider({ solana: provider }), provider)
  assert.equal(getPhantomProvider({ phantom: { solana: provider }, solana: { ...provider, isPhantom: false } }), provider)
  assert.equal(getPhantomProvider({ solana: { ...provider, isPhantom: false } }), undefined)
  assert.equal(getPhantomProvider({}), undefined)
})

test('validates extension public keys and rejects missing and malformed addresses', () => {
  assert.equal(phantomAddress(key), key.toBase58())
  assert.throws(() => phantomAddress(null), { message: 'Phantom returned a missing public key.' })
  assert.throws(() => phantomAddress({} as any), { message: 'Phantom returned a missing public key.' })
  assert.throws(() => phantomAddress({ toBase58: () => 'invalid!' }), { message: /Non-base58 character/ })
})

test('connects, tracks account changes and revocation, disconnects, and removes listeners', async () => {
  const mock = fakeProvider()
  const addresses: Array<string | undefined> = []
  const session = new PhantomSession()
  session.attach(mock.provider, address => addresses.push(address))
  assert.equal(mock.count(), 2)
  await session.connect()
  assert.equal(addresses.at(-1), key.toBase58())
  mock.emit('accountChanged', secondKey)
  assert.equal(addresses.at(-1), secondKey.toBase58())
  mock.emit('accountChanged', null)
  assert.equal(addresses.at(-1), undefined)
  await session.connect()
  mock.emit('disconnect')
  assert.equal(addresses.at(-1), undefined)
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
  const session = new PhantomSession()
  session.attach(undefined, () => {})
  await assert.rejects(() => session.connect(), { message: /Phantom is not installed/ })
  await assert.rejects(() => session.disconnect(), { message: /Phantom is not installed/ })
  const { provider } = fakeProvider()
  session.attach(provider, () => {})
  provider.connect = async () => { throw new Error('User rejected the request.') }
  await assert.rejects(() => session.connect(), { message: 'User rejected the request.' })
  provider.connect = async () => ({ publicKey: null as any })
  await assert.rejects(() => session.connect(), { message: 'Phantom returned a missing public key.' })
  provider.disconnect = async () => { throw new Error('Disconnect failed.') }
  await assert.rejects(() => session.disconnect(), { message: 'Disconnect failed.' })
  session.detach()
})

test('late approval cannot reconnect after mode change, unmount, revocation, or a newer request', async () => {
  for (const cancel of ['detach', 'accountChanged', 'disconnect', 'newerRequest']) {
    const mock = fakeProvider()
    const addresses: Array<string | undefined> = []
    const session = new PhantomSession()
    session.attach(mock.provider, address => addresses.push(address))
    let approve!: (value: { publicKey: typeof key }) => void
    mock.provider.connect = () => new Promise(resolve => { approve = resolve })
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
  const session = new PhantomSession()
  session.attach(first.provider, () => {})
  session.attach(first.provider, () => {})
  assert.equal(first.count(), 2)
  session.attach(second.provider, () => {})
  assert.equal(first.count(), 0)
  assert.equal(second.count(), 2)
  session.detach()
  assert.equal(second.count(), 0)
})
