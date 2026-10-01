import { Keypair, PublicKey } from '@solana/web3.js'

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const STORAGE_KEY_WALLET_SECRET = 'comfi_in_browser_wallet_secret_key'
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

/**
 * Encodes a Uint8Array into a Base58 string.
 */
export function toBase58(buffer: Uint8Array): string {
  if (!buffer || buffer.length === 0) {
    throw new Error('Invalid buffer provided to toBase58: expected non-empty Uint8Array.')
  }
  const digits = [0]
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) {
      digits[j] <<= 8
    }
    digits[0] += buffer[i]
    let carry = 0
    for (let j = 0; j < digits.length; ++j) {
      digits[j] += carry
      carry = (digits[j] / 58) | 0
      digits[j] %= 58
    }
    while (carry) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  for (let i = 0; buffer[i] === 0 && i < buffer.length - 1; i++) {
    digits.push(0)
  }
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join('')
}

const BASE58_MAP = new Map<string, number>()
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP.set(BASE58_ALPHABET[i], i)
}

/**
 * Decodes a Base58 string into a Uint8Array.
 * Strictly validates characters and non-empty input; escalates on invalid data.
 */
export function fromBase58(str: string): Uint8Array {
  if (typeof str !== 'string' || str.trim().length === 0) {
    throw new Error('Invalid base58 string: input must be a non-empty string.')
  }
  const clean = str.trim()
  const bytes = [0]
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    const val = BASE58_MAP.get(c)
    if (val === undefined) {
      throw new Error(`Invalid base58 character '${c}' at index ${i}.`)
    }
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] *= 58
    }
    bytes[0] += val
    let carry = 0
    for (let j = 0; j < bytes.length; ++j) {
      bytes[j] += carry
      carry = bytes[j] >> 8
      bytes[j] &= 0xff
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (let i = 0; i < clean.length && clean[i] === '1'; i++) {
    bytes.push(0)
  }
  return new Uint8Array(bytes.reverse())
}

export type KeypairExport = {
  publicKeyBase58: string
  secretKeyBase58: string
  secretKeyJson: string
}

/**
 * Exports a Solana Keypair into standard Base58 and JSON byte array formats.
 */
export function exportKeypair(keypair: Keypair): KeypairExport {
  if (!keypair || !keypair.secretKey || !(keypair.secretKey instanceof Uint8Array)) {
    throw new Error('Invalid keypair provided for export: missing secretKey Uint8Array.')
  }
  const secretKeyBase58 = toBase58(keypair.secretKey)
  const secretKeyJson = JSON.stringify(Array.from(keypair.secretKey))
  const publicKeyBase58 = keypair.publicKey.toBase58()

  return {
    publicKeyBase58,
    secretKeyBase58,
    secretKeyJson,
  }
}

/**
 * Generates a brand new persistent in-browser Solana keypair.
 */
export function generateNewKeypair(): { keypair: Keypair; exportData: KeypairExport } {
  const keypair = Keypair.generate()
  const exportData = exportKeypair(keypair)
  return { keypair, exportData }
}

/**
 * Imports a Solana Keypair from either:
 * 1. Base58 encoded string (64 bytes secretKey or 32 bytes seed)
 * 2. JSON array of numbers string (e.g. "[1,2,3...]")
 *
 * Escalates immediately on invalid format or byte lengths without evading errors.
 */
export function importKeypairFromSecret(input: string): Keypair {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('Secret key input cannot be empty.')
  }

  const trimmed = input.trim()
  let bytes: Uint8Array

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('Invalid JSON format for secret key array.')
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Invalid secret key JSON: expected an array of byte integers.')
    }

    for (let i = 0; i < parsed.length; i++) {
      const val = parsed[i]
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 255) {
        throw new Error(`Invalid byte at index ${i}: must be an integer between 0 and 255.`)
      }
    }
    bytes = new Uint8Array(parsed)
  } else {
    // Treat as Base58 string
    bytes = fromBase58(trimmed)
  }

  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes)
  } else if (bytes.length === 32) {
    return Keypair.fromSeed(bytes)
  } else {
    throw new Error(`Invalid secret key byte length: expected 32-byte seed or 64-byte secret key, got ${bytes.length} bytes.`)
  }
}

/**
 * Retrieves the stored secret key from storage.
 */
export function getStoredWalletSecret(storage?: Storage): string | null {
  const targetStorage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!targetStorage) return null
  return targetStorage.getItem(STORAGE_KEY_WALLET_SECRET)
}

/**
 * Persists a secret key string (Base58) to storage.
 */
export function storeWalletSecret(secretBase58: string, storage?: Storage): void {
  if (!secretBase58 || typeof secretBase58 !== 'string') {
    throw new Error('Invalid secret key to store: must be non-empty string.')
  }
  const targetStorage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!targetStorage) return
  targetStorage.setItem(STORAGE_KEY_WALLET_SECRET, secretBase58)
}

/**
 * Clears the stored secret key from storage.
 */
export function clearStoredWalletSecret(storage?: Storage): void {
  const targetStorage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!targetStorage) return
  targetStorage.removeItem(STORAGE_KEY_WALLET_SECRET)
}

/**
 * Loads an existing keypair from localStorage or creates and persists a new one.
 */
export function getOrCreateInBrowserKeypair(storage?: Storage): Keypair {
  const stored = getStoredWalletSecret(storage)
  if (stored) {
    try {
      return importKeypairFromSecret(stored)
    } catch {
      // If corrupted in storage, re-generate below
    }
  }

  const { keypair, exportData } = generateNewKeypair()
  storeWalletSecret(exportData.secretKeyBase58, storage)
  return keypair
}

/**
 * Queries the SOL balance for a given address from the Solana RPC endpoint.
 * Returns balance in SOL (e.g. 1.25). Escalates on RPC or network failures.
 */
export async function fetchSolBalance(rpcUrl: string, publicKey: string): Promise<number> {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new Error('Missing or invalid rpcUrl for fetchSolBalance.')
  }
  if (!publicKey || typeof publicKey !== 'string') {
    throw new Error('Missing or invalid publicKey for fetchSolBalance.')
  }

  // Validate public key format
  new PublicKey(publicKey)

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sol-balance-check',
      method: 'getBalance',
      params: [publicKey, { commitment: 'confirmed' }],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error ${response.status} when querying SOL balance for ${publicKey}.`)
  }

  const json = await response.json() as {
    result?: { value: number }
    error?: { message: string }
  }

  if (json.error) {
    throw new Error(`Solana RPC error when querying SOL balance: ${json.error.message}`)
  }

  if (json.result == null || typeof json.result.value !== 'number') {
    throw new Error('Invalid RPC response format for getBalance: missing result.value.')
  }

  return json.result.value / 1e9
}

/**
 * Queries the USDC (or SPL token) balance for a given address.
 * Formats as a USD currency string (e.g. "$500.00").
 */
export async function fetchUsdcBalance(rpcUrl: string, publicKey: string, usdcMint?: string): Promise<string> {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new Error('Missing or invalid rpcUrl for fetchUsdcBalance.')
  }
  if (!publicKey || typeof publicKey !== 'string') {
    throw new Error('Missing or invalid publicKey for fetchUsdcBalance.')
  }

  new PublicKey(publicKey)

  const filterParam = usdcMint
    ? { mint: usdcMint }
    : { programId: TOKEN_PROGRAM_ID }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'usdc-balance-check',
      method: 'getTokenAccountsByOwner',
      params: [
        publicKey,
        filterParam,
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error ${response.status} when querying token accounts for ${publicKey}.`)
  }

  const json = await response.json() as {
    result?: {
      value: Array<{
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  uiAmountString?: string
                  uiAmount?: number
                  amount?: string
                }
              }
            }
          }
        }
      }>
    }
    error?: { message: string }
  }

  if (json.error) {
    throw new Error(`Solana RPC error when querying token accounts: ${json.error.message}`)
  }

  const accounts = json.result?.value ?? []
  if (accounts.length === 0) {
    return '$0.00'
  }

  let totalAmount = 0
  for (const acc of accounts) {
    const info = acc.account.data.parsed.info.tokenAmount
    if (info.uiAmount != null) {
      totalAmount += info.uiAmount
    } else if (info.uiAmountString != null) {
      totalAmount += parseFloat(info.uiAmountString) || 0
    }
  }

  return `$${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Requests a SOL airdrop from localnet or devnet for a given address.
 * Escalates on invalid parameters or RPC errors.
 */
export async function requestSolAirdrop(rpcUrl: string, publicKey: string, solAmount = 1): Promise<string> {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new Error('Missing or invalid rpcUrl for requestSolAirdrop.')
  }
  if (!publicKey || typeof publicKey !== 'string') {
    throw new Error('Missing or invalid publicKey for requestSolAirdrop.')
  }
  if (typeof solAmount !== 'number' || !Number.isFinite(solAmount) || solAmount <= 0) {
    throw new Error(`Invalid solAmount for airdrop: must be positive number, received ${solAmount}.`)
  }

  new PublicKey(publicKey)

  const lamports = Math.round(solAmount * 1e9)

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sol-airdrop-request',
      method: 'requestAirdrop',
      params: [publicKey, lamports],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error ${response.status} during requestAirdrop.`)
  }

  const json = await response.json() as {
    result?: string
    error?: { message: string; code?: number }
  }

  if (json.error) {
    throw new Error(`Solana airdrop request failed: ${json.error.message}`)
  }

  if (!json.result || typeof json.result !== 'string') {
    throw new Error('Invalid response from requestAirdrop: expected transaction signature string.')
  }

  return json.result
}
