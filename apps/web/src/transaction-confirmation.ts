import type { BlockhashWithExpiryBlockHeight, Connection } from '@solana/web3.js'

// HTTP confirmation also works on localnet RPCs without websocket forwarding.
// A timeout is an uncertain result: keep the account credential and read state
// before retrying, rather than reporting success or generating another identity.
export async function confirmWalletTransaction(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>,
  signature: string,
  latest: BlockhashWithExpiryBlockHeight,
  timeoutMs = 60_000,
): Promise<void> {
  if (!signature) throw new Error('Missing transaction signature.')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0]
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return
    if (await connection.getBlockHeight('confirmed') > latest.lastValidBlockHeight) throw new Error(`Transaction expired before confirmation: ${signature}. Load the account before retrying.`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Transaction confirmation timed out: ${signature}. Load the account before retrying.`)
}
