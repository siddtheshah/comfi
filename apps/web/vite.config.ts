import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { Connection, PublicKey } from '@solana/web3.js'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function mockWalletPoolApi(rpcUrl: string, programIdStr: string): Plugin {
  const programId = new PublicKey(programIdStr)
  return {
    name: 'comfi-mock-wallet-pool-api',
    configureServer(server) {
      const run = (path: string, operation: 'initialize' | 'next') => server.middlewares.use(path, (request, response, next) => {
        if (request.method !== 'POST') return next()
        void (async () => {
          response.setHeader('content-type', 'application/json')
          try {
            const program = await new Connection(rpcUrl, 'confirmed').getAccountInfo(programId)
            if (!program?.executable) {
              response.statusCode = 412
              return response.end(JSON.stringify({ error: 'ComFi is not deployed to this localnet. Run the localnet deployment command, then retry initialization.' }))
            }
            const child = spawn(process.execPath, [resolve(workspaceRoot, 'scripts/create-test-pool.mjs')], {
              cwd: workspaceRoot,
              env: { ...process.env, COMFI_LOCALNET_RPC: rpcUrl, COMFI_POOL_MODE: operation },
            })
            let output = ''
            let error = ''
            child.stdout.on('data', (chunk) => { output += chunk })
            child.stderr.on('data', (chunk) => { error += chunk })
            child.on('close', (code) => {
              if (code !== 0) {
                response.statusCode = 422
                const message = error.includes('has not been initialized')
                  ? 'Initialize the localnet deployer before creating a pool.'
                  : `Localnet ${operation} failed. Check the Vite terminal for details.`
                return response.end(JSON.stringify({ error: message }))
              }
              response.end(output)
            })
          } catch {
            response.statusCode = 503
            response.end(JSON.stringify({ error: `Cannot reach localnet at ${rpcUrl}. Start the validator and deploy ComFi first.` }))
          }
        })()
      })
      run('/__comfi/mock-wallet/initialize', 'initialize')
      run('/__comfi/mock-wallet/create-pool', 'next')
      server.middlewares.use('/__comfi/mock-wallet/pools', (request, response, next) => {
        if (request.method !== 'GET') return next()
        void (async () => {
          response.setHeader('content-type', 'application/json')
          try {
            const connection = new Connection(rpcUrl, 'confirmed')
            const program = await connection.getAccountInfo(programId)
            if (!program?.executable) {
              response.statusCode = 412
              return response.end(JSON.stringify({ error: 'ComFi is not deployed to this localnet.', pools: [] }))
            }
            const accounts = await connection.getProgramAccounts(programId, {
              filters: [{ memcmp: { offset: 0, bytes: 'hQrXeCntzbV' } }],
            })
            const pools = await Promise.all(
              accounts.map(async (acc) => {
                const data = acc.account.data
                const id = Number(data.readBigUInt64LE(40))
                const creator = new PublicKey(data.subarray(48, 80)).toBase58()
                const vault = new PublicKey(data.subarray(80, 112)).toBase58()
                const memberCap = data.readUInt32LE(112)
                const memberCount = data.readUInt32LE(116)
                const minimumDepositAtomic = data.readBigUInt64LE(120).toString()
                const voteThreshold = data.readUInt32LE(128)
                const votingPeriodSeconds = data.readBigInt64LE(132).toString()
                const timelockSeconds = data.readBigInt64LE(140).toString()
                const currentCycle = data.readBigUInt64LE(148).toString()
                const cycleDurationSeconds = data.readBigInt64LE(156).toString()
                const cycleStartedAt = data.readBigInt64LE(164).toString()
                const nextRequestId = data.readBigUInt64LE(188).toString()
                const nextProposalId = data.readBigUInt64LE(196).toString()

                const bal = await connection.getTokenAccountBalance(new PublicKey(vault))
                const num = Number(bal.value.uiAmountString ?? '0')
                const balance = `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

                return {
                  address: acc.pubkey.toBase58(),
                  id,
                  creator,
                  vault,
                  memberCap,
                  memberCount,
                  minimumDepositAtomic,
                  voteThreshold,
                  votingPeriodSeconds,
                  timelockSeconds,
                  currentCycle,
                  cycleDurationSeconds,
                  cycleStartedAt,
                  nextRequestId,
                  nextProposalId,
                  balance,
                }
              })
            )
            pools.sort((a, b) => a.id - b.id)
            response.end(JSON.stringify({ pools }))
          } catch {
            response.statusCode = 503
            response.end(JSON.stringify({ error: `Cannot reach localnet at ${rpcUrl}.`, pools: [] }))
          }
        })()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, '')
  const rpcUrl = env.VITE_SOLANA_RPC || env.COMFI_LOCALNET_RPC
  if (!rpcUrl) {
    throw new Error('Missing required environment variable: VITE_SOLANA_RPC (or COMFI_LOCALNET_RPC)')
  }
  const programId = env.VITE_PROGRAM_ID
  if (!programId) {
    throw new Error('Missing required environment variable: VITE_PROGRAM_ID')
  }
  return {
    envDir: workspaceRoot,
    plugins: [react(), mockWalletPoolApi(rpcUrl, programId)],
  }
})
