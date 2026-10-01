import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@solana/web3.js'
import {
  clearStoredWalletSecret,
  exportKeypair,
  fetchSolBalance,
  fetchUsdcBalance,
  fromBase58,
  generateNewKeypair,
  getOrCreateInBrowserKeypair,
  getStoredWalletSecret,
  importKeypairFromSecret,
  requestSolAirdrop,
  storeWalletSecret,
} from '../src/in-browser-wallet.ts'
import { toBase58 } from '../src/solana.ts'

test('Base58 encoding and decoding round-trips correctly', () => {
  const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128, 42])
  const encoded = toBase58(original)
  const decoded = fromBase58(encoded)
  assert.deepEqual(decoded, original)
})

test('fromBase58 rejects invalid and empty inputs without evading failures', () => {
  assert.throws(() => fromBase58(''), {
    message: /Invalid base58 string: input must be a non-empty string/,
  })
  assert.throws(() => fromBase58('   '), {
    message: /Invalid base58 string: input must be a non-empty string/,
  })
  // '0', 'O', 'I', 'l' are invalid base58 characters
  assert.throws(() => fromBase58('23450678'), {
    message: /Invalid base58 character '0'/,
  })
  assert.throws(() => fromBase58('2345O678'), {
    message: /Invalid base58 character 'O'/,
  })
})

test('generateNewKeypair generates a valid Solana keypair with complete export formats', () => {
  const { keypair, exportData } = generateNewKeypair()

  assert.equal(keypair.secretKey.length, 64)
  assert.equal(typeof exportData.publicKeyBase58, 'string')
  assert.ok(exportData.publicKeyBase58.length >= 32)
  assert.equal(exportData.publicKeyBase58, keypair.publicKey.toBase58())

  assert.equal(typeof exportData.secretKeyBase58, 'string')
  assert.equal(typeof exportData.secretKeyJson, 'string')

  const parsedJson = JSON.parse(exportData.secretKeyJson)
  assert.ok(Array.isArray(parsedJson))
  assert.equal(parsedJson.length, 64)
})

test('exportKeypair correctly exports keypair to Base58 and JSON formats', () => {
  const keypair = Keypair.generate()
  const exported = exportKeypair(keypair)

  assert.equal(exported.publicKeyBase58, keypair.publicKey.toBase58())
  assert.equal(exported.secretKeyBase58, toBase58(keypair.secretKey))

  const parsedArray = JSON.parse(exported.secretKeyJson)
  assert.deepEqual(parsedArray, Array.from(keypair.secretKey))
})

test('exportKeypair rejects invalid keypair parameter', () => {
  assert.throws(() => {
    exportKeypair(null as any)
  }, { message: /Invalid keypair provided for export/ })

  assert.throws(() => {
    exportKeypair({} as any)
  }, { message: /Invalid keypair provided for export/ })
})

test('importKeypairFromSecret restores keypair from Base58 64-byte secret key', () => {
  const original = Keypair.generate()
  const base58Secret = toBase58(original.secretKey)

  const restored = importKeypairFromSecret(base58Secret)
  assert.equal(restored.publicKey.toBase58(), original.publicKey.toBase58())
  assert.deepEqual(restored.secretKey, original.secretKey)
})

test('importKeypairFromSecret restores keypair from 32-byte seed in Base58', () => {
  const original = Keypair.generate()
  const seed = original.secretKey.subarray(0, 32)
  const base58Seed = toBase58(seed)

  const restored = importKeypairFromSecret(base58Seed)
  assert.equal(restored.publicKey.toBase58(), original.publicKey.toBase58())
})

test('importKeypairFromSecret restores keypair from JSON array format', () => {
  const original = Keypair.generate()
  const jsonStr = JSON.stringify(Array.from(original.secretKey))

  const restored = importKeypairFromSecret(jsonStr)
  assert.equal(restored.publicKey.toBase58(), original.publicKey.toBase58())
  assert.deepEqual(restored.secretKey, original.secretKey)
})

test('importKeypairFromSecret escalates on invalid secret key inputs', () => {
  assert.throws(() => importKeypairFromSecret(''), {
    message: /Secret key input cannot be empty/,
  })
  assert.throws(() => importKeypairFromSecret('   '), {
    message: /Secret key input cannot be empty/,
  })
  // Malformed JSON
  assert.throws(() => importKeypairFromSecret('[1, 2, notANumber]'), {
    message: /Invalid JSON format/,
  })
  // Valid JSON but not an array of byte ints
  assert.throws(() => importKeypairFromSecret('[1, -5, 3]'), {
    message: /Invalid byte at index 1: must be an integer between 0 and 255/,
  })
  assert.throws(() => importKeypairFromSecret('[1, 300, 3]'), {
    message: /Invalid byte at index 1: must be an integer between 0 and 255/,
  })
  // Wrong byte length (e.g. 5 bytes)
  assert.throws(() => importKeypairFromSecret('[1, 2, 3, 4, 5]'), {
    message: /Invalid secret key byte length: expected 32-byte seed or 64-byte secret key, got 5 bytes/,
  })
})

test('mock storage persists and clears wallet secret', () => {
  const store: Record<string, string> = {}
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    key: (i: number) => Object.keys(store)[i] ?? null,
    length: 0,
  } as unknown as Storage

  assert.equal(getStoredWalletSecret(mockStorage), null)

  const original = Keypair.generate()
  const secret = toBase58(original.secretKey)
  storeWalletSecret(secret, mockStorage)

  assert.equal(getStoredWalletSecret(mockStorage), secret)

  clearStoredWalletSecret(mockStorage)
  assert.equal(getStoredWalletSecret(mockStorage), null)
})

test('getOrCreateInBrowserKeypair loads persisted keypair or creates new', () => {
  const store: Record<string, string> = {}
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => {},
    key: () => null,
    length: 0,
  } as unknown as Storage

  const kp1 = getOrCreateInBrowserKeypair(mockStorage)
  assert.ok(kp1.publicKey.toBase58())

  // Calling again should load the exact same keypair
  const kp2 = getOrCreateInBrowserKeypair(mockStorage)
  assert.equal(kp2.publicKey.toBase58(), kp1.publicKey.toBase58())
})

test('fetchSolBalance escalates on missing or invalid parameters', async () => {
  await assert.rejects(
    async () => {
      await fetchSolBalance('', '11111111111111111111111111111111')
    },
    { message: /Missing or invalid rpcUrl/ }
  )

  await assert.rejects(
    async () => {
      await fetchSolBalance('http://127.0.0.1:8899', '')
    },
    { message: /Missing or invalid publicKey/ }
  )

  await assert.rejects(
    async () => {
      await fetchSolBalance('http://127.0.0.1:8899', 'invalid-pubkey-format')
    },
    { message: /Non-base58 character/ }
  )
})

test('fetchUsdcBalance escalates on missing or invalid parameters', async () => {
  await assert.rejects(
    async () => {
      await fetchUsdcBalance('', '11111111111111111111111111111111')
    },
    { message: /Missing or invalid rpcUrl/ }
  )

  await assert.rejects(
    async () => {
      await fetchUsdcBalance('http://127.0.0.1:8899', '')
    },
    { message: /Missing or invalid publicKey/ }
  )
})

test('requestSolAirdrop escalates on missing or invalid parameters', async () => {
  await assert.rejects(
    async () => {
      await requestSolAirdrop('', '11111111111111111111111111111111', 1)
    },
    { message: /Missing or invalid rpcUrl/ }
  )

  await assert.rejects(
    async () => {
      await requestSolAirdrop('http://127.0.0.1:8899', '11111111111111111111111111111111', -1)
    },
    { message: /Invalid solAmount for airdrop/ }
  )

  await assert.rejects(
    async () => {
      await requestSolAirdrop('http://127.0.0.1:8899', '11111111111111111111111111111111', 0)
    },
    { message: /Invalid solAmount for airdrop/ }
  )
})
