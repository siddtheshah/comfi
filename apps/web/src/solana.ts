import type { PoolItem } from './data'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const POOL_DISCRIMINATOR_BS58 = 'hQrXeCntzbV' // sha256("account:Pool")[..8]

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

export type OnChainPool = {
  address: string
  id: number
  creator: string
  vault: string
  memberCap: number
  memberCount: number
  minimumDepositAtomic: bigint
  memberObligationAmountAtomic: bigint
  voteThreshold: number
  votingPeriodSeconds: bigint
  timelockSeconds: bigint
  currentCycle: bigint
  cycleDurationSeconds: bigint
  cycleStartedAt: bigint
  actionAllowancePerCycle: bigint
  maxSponsoredActionCharge: bigint
  nextRequestId: bigint
  nextProposalId: bigint
  testingEnabled: boolean
  hasPendingConfig: boolean
  pendingVoteThreshold: number
  pendingCycleDurationSeconds: bigint
  pendingMemberObligationAmountAtomic: bigint
  balanceUsdc: string
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export function decodePoolAccountData(address: string, dataBytes: Uint8Array): Omit<OnChainPool, 'balanceUsdc'> {
  if (dataBytes.length < 205) {
    throw new Error(`Invalid Pool account data length for ${address}: expected at least 205 bytes, got ${dataBytes.length}`)
  }
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength)
  const idBig = view.getBigUint64(40, true)
  const creator = toBase58(dataBytes.subarray(48, 80))
  const vault = toBase58(dataBytes.subarray(80, 112))
  const memberCap = view.getUint32(112, true)
  const memberCount = view.getUint32(116, true)
  const minimumDepositAtomic = view.getBigUint64(120, true)

  // Backward-compatible decode if an older 206-byte pool exists
  const isNewLayout = dataBytes.length >= 235
  const memberObligationAmountAtomic = isNewLayout ? view.getBigUint64(128, true) : minimumDepositAtomic
  const voteThreshold = isNewLayout ? view.getUint32(136, true) : view.getUint32(128, true)
  const votingPeriodSeconds = isNewLayout ? view.getBigInt64(140, true) : view.getBigInt64(132, true)
  const timelockSeconds = isNewLayout ? view.getBigInt64(148, true) : view.getBigInt64(140, true)
  const currentCycle = isNewLayout ? view.getBigUint64(156, true) : view.getBigUint64(148, true)
  const cycleDurationSeconds = isNewLayout ? view.getBigInt64(164, true) : view.getBigInt64(156, true)
  const cycleStartedAt = isNewLayout ? view.getBigInt64(172, true) : view.getBigInt64(164, true)
  const actionAllowancePerCycle = isNewLayout ? view.getBigUint64(180, true) : view.getBigUint64(172, true)
  const maxSponsoredActionCharge = isNewLayout ? view.getBigUint64(188, true) : view.getBigUint64(180, true)
  const nextRequestId = isNewLayout ? view.getBigUint64(196, true) : view.getBigUint64(188, true)
  const nextProposalId = isNewLayout ? view.getBigUint64(204, true) : view.getBigUint64(196, true)
  const testingEnabled = isNewLayout ? view.getUint8(213) === 1 : (dataBytes.length >= 206 ? view.getUint8(205) === 1 : false)
  const hasPendingConfig = isNewLayout ? view.getUint8(214) === 1 : false
  const pendingVoteThreshold = isNewLayout ? view.getUint32(215, true) : voteThreshold
  const pendingCycleDurationSeconds = isNewLayout ? view.getBigInt64(219, true) : cycleDurationSeconds
  const pendingMemberObligationAmountAtomic = isNewLayout ? view.getBigUint64(227, true) : memberObligationAmountAtomic

  return {
    address,
    id: Number(idBig),
    creator,
    vault,
    memberCap,
    memberCount,
    minimumDepositAtomic,
    memberObligationAmountAtomic,
    voteThreshold,
    votingPeriodSeconds,
    timelockSeconds,
    currentCycle,
    cycleDurationSeconds,
    cycleStartedAt,
    actionAllowancePerCycle,
    maxSponsoredActionCharge,
    nextRequestId,
    nextProposalId,
    testingEnabled,
    hasPendingConfig,
    pendingVoteThreshold,
    pendingCycleDurationSeconds,
    pendingMemberObligationAmountAtomic,
  }
}

export async function fetchVaultBalance(rpcUrl: string, vaultPubkey: string): Promise<string> {
  if (!rpcUrl) throw new Error('Missing rpcUrl in fetchVaultBalance')
  if (!vaultPubkey) throw new Error('Missing vaultPubkey in fetchVaultBalance')

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'getTokenAccountBalance',
      params: [vaultPubkey],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error ${response.status} fetching vault balance`)
  }

  const json = await response.json() as { result?: { value?: { uiAmountString?: string; amount?: string } }; error?: { message: string } }
  if (json.error) {
    throw new Error(`Solana RPC error fetching vault balance for ${vaultPubkey}: ${json.error.message}`)
  }

  if (json.result?.value?.uiAmountString != null) {
    const num = Number(json.result.value.uiAmountString)
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (json.result?.value?.amount != null) {
    const atomic = BigInt(json.result.value.amount)
    const dollars = Number(atomic) / 1e6
    return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return '$0.00'
}

export async function fetchOnChainPools(rpcUrl: string, programId: string): Promise<OnChainPool[]> {
  if (!rpcUrl) throw new Error('Missing required argument: rpcUrl')
  if (!programId) throw new Error('Missing required argument: programId')

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        programId,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_BS58 } }],
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Solana RPC returned status ${response.status} when querying program accounts`)
  }

  const json = await response.json() as {
    result?: Array<{ pubkey: string; account: { data: [string, string] } }>
    error?: { message: string }
  }

  if (json.error) {
    throw new Error(`Solana RPC error: ${json.error.message}`)
  }

  const rawList = json.result ?? []
  const poolsWithoutBalance = rawList.map(item => {
    const rawBytes = base64ToUint8Array(item.account.data[0])
    return decodePoolAccountData(item.pubkey, rawBytes)
  })

  // Sort by pool ID ascending
  poolsWithoutBalance.sort((a, b) => a.id - b.id)

  // Fetch balances in parallel
  const pools: OnChainPool[] = await Promise.all(
    poolsWithoutBalance.map(async pool => {
      const balanceUsdc = await fetchVaultBalance(rpcUrl, pool.vault)
      return { ...pool, balanceUsdc }
    })
  )

  return pools
}

const ICONS = ['✦', '♣', '☻', '★', '◆', '✺']
const ACCENTS = ['coral', 'lime', 'sky', 'violet']

export function onChainPoolToPoolItem(pool: OnChainPool, currentWalletPubkey?: string): PoolItem {
  const isCreator = currentWalletPubkey && pool.creator.toLowerCase() === currentWalletPubkey.toLowerCase()
  const icon = ICONS[pool.id % ICONS.length]
  const accent = ACCENTS[pool.id % ACCENTS.length]
  const minDepositDollars = Number(pool.minimumDepositAtomic) / 1e6
  const formattedMinDeposit = `$${minDepositDollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return {
    id: `pool-${pool.id}`,
    icon,
    accent,
    name: `Community Pool #${pool.id}`,
    role: isCreator ? 'Admin & Creator' : 'Member',
    status: `Active · Cycle ${pool.currentCycle.toString()}`,
    balance: pool.balanceUsdc,
    funds: `${pool.memberCount} of ${pool.memberCap}`,
    nextDate: 'Cycle renewal',
    proposals: Number(pool.nextProposalId),
    requests: Number(pool.nextRequestId),
    cap: pool.memberCap,
    slots: pool.memberCap - pool.memberCount,
    address: pool.address,
    vault: pool.vault,
    creator: pool.creator,
    onChain: true,
    minimumDeposit: formattedMinDeposit,
    voteThreshold: pool.voteThreshold,
    votingPeriodSeconds: Number(pool.votingPeriodSeconds),
    timelockSeconds: Number(pool.timelockSeconds),
    currentCycle: Number(pool.currentCycle),
    cycleStartedAt: Number(pool.cycleStartedAt),
  }
}
