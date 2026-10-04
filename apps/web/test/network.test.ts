import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRpcHealth, initialNetwork, networkEndpoints, validateNetwork, validateRpcEndpoint } from '../src/network.ts'

test('network configuration selects known clusters and requires a label for custom RPCs', () => {
  assert.equal(initialNetwork('http://127.0.0.1:8899'), 'localnet')
  assert.equal(initialNetwork('http://[::1]:8899'), 'localnet')
  assert.equal(initialNetwork('https://api.devnet.solana.com'), 'devnet')
  assert.equal(initialNetwork('https://api.testnet.solana.com'), 'testnet')
  assert.equal(initialNetwork('https://custom.example/rpc', 'testnet'), 'testnet')
  assert.throws(() => initialNetwork('https://devnet.example'), { message: /Set VITE_SOLANA_NETWORK/ })
  assert.throws(() => initialNetwork('https://api.devnet.solana.com', 'mainnet'), { message: /Unsupported Solana network/ })
  assert.throws(() => validateNetwork(''), { message: /Unsupported Solana network/ })
})

test('RPC configuration rejects malformed URLs, unsupported protocols and embedded credentials', () => {
  assert.equal(validateRpcEndpoint(' https://rpc.example/path '), 'https://rpc.example/path')
  assert.throws(() => validateRpcEndpoint(''), { message: /Enter an HTTP or HTTPS/ })
  assert.throws(() => validateRpcEndpoint('not-a-url'), { code: 'ERR_INVALID_URL' })
  assert.throws(() => validateRpcEndpoint('file:///tmp/test'), { message: /HTTP or HTTPS RPC URL/ })
  assert.throws(() => validateRpcEndpoint('https://user:password@rpc.example'), { message: /without embedded credentials/ })
})

test('per-network endpoints preserve the configured startup URL and validate overrides', () => {
  assert.deepEqual(networkEndpoints('http://localhost:8890', 'localnet', { devnet: 'https://custom.example' }), {
    localnet: 'http://localhost:8890', devnet: 'https://custom.example', testnet: 'https://api.testnet.solana.com',
  })
  assert.throws(() => networkEndpoints('http://localhost:8899', 'mainnet' as any), { message: /Unsupported Solana network/ })
  assert.throws(() => networkEndpoints('http://localhost:8899', 'localnet', { devnet: 'ftp://example.com' }), { message: /HTTP or HTTPS/ })
})

test('RPC health checks report node health and explicitly reject failures', async t => {
  let response = new Response(JSON.stringify({ result: 'ok' }))
  let failure: Error | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    assert.equal(JSON.parse(options.body as string).method, 'getHealth')
    assert.ok(options.signal)
    if (failure) throw failure
    return response
  })
  await checkRpcHealth('https://rpc.example')
  response = new Response('', { status: 503 })
  await assert.rejects(() => checkRpcHealth('https://rpc.example'), { message: 'RPC returned HTTP 503.' })
  response = new Response(JSON.stringify({ error: { message: 'Node is behind' } }))
  await assert.rejects(() => checkRpcHealth('https://rpc.example'), { message: 'RPC health error: Node is behind' })
  response = new Response('{}')
  await assert.rejects(() => checkRpcHealth('https://rpc.example'), { message: 'RPC did not report a healthy node.' })
  failure = new Error('Network failed')
  await assert.rejects(() => checkRpcHealth('https://rpc.example'), { message: 'Network failed' })
  failure = new DOMException('Timed out', 'TimeoutError')
  await assert.rejects(() => checkRpcHealth('https://rpc.example'), { name: 'TimeoutError', message: 'Timed out' })
  await assert.rejects(() => checkRpcHealth(''), { message: /Enter an HTTP or HTTPS/ })
})

test('RPC health checks forward cancellation instead of treating an aborted request as healthy', async t => {
  const controller = new AbortController()
  controller.abort()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    options.signal!.throwIfAborted()
    return new Response(JSON.stringify({ result: 'ok' }))
  })
  await assert.rejects(() => checkRpcHealth('https://rpc.example', controller.signal), { name: 'AbortError' })
})
