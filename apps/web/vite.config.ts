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
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => {
          void (async () => {
            response.setHeader('content-type', 'application/json')
            try {
              const program = await new Connection(rpcUrl, 'confirmed').getAccountInfo(programId)
              if (!program?.executable) {
                response.statusCode = 412
                return response.end(JSON.stringify({ error: 'ComFi is not deployed to this localnet. Run the localnet deployment command, then retry initialization.' }))
              }
              const envOverrides: Record<string, string> = {}
              if (body && body.trim().startsWith('{')) {
                const params = JSON.parse(body)
                if (params.memberCap) envOverrides.COMFI_MEMBER_CAP = String(params.memberCap)
                if (params.memberObligationAmount) envOverrides.COMFI_MEMBER_OBLIGATION = String(params.memberObligationAmount)
                if (params.minimumDeposit) envOverrides.COMFI_MIN_DEPOSIT = String(params.minimumDeposit)
                if (params.cycleDurationSeconds) envOverrides.COMFI_CYCLE_DURATION = String(params.cycleDurationSeconds)
                if (params.voteThresholdBps || params.voteThreshold) envOverrides.COMFI_VOTE_THRESHOLD = String(params.voteThresholdBps ?? params.voteThreshold)
                if (params.executionMode) envOverrides.COMFI_EXEC_MODE = String(params.executionMode)
              }
              const child = spawn(process.execPath, [resolve(workspaceRoot, 'scripts/create-test-pool.mjs')], {
                cwd: workspaceRoot,
                env: { ...process.env, COMFI_LOCALNET_RPC: rpcUrl, COMFI_POOL_MODE: operation, ...envOverrides },
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
                const vault = new PublicKey(data.subarray(80, 112))
                const bal = await connection.getTokenAccountBalance(vault)
                // Send the original account bytes; use the same Borsh decoder as direct RPC.
                return {
                  address: acc.pubkey.toBase58(),
                  data: data.toString('base64'),
                  vaultBalanceAtomic: bal.value.amount,
                }
              })
            )
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
    resolve: {
      alias: {
        buffer: 'buffer/',
      },
    },
    define: {
      global: 'globalThis',
    },
    plugins: [react(), mockWalletPoolApi(rpcUrl, programId)],
  }
})
