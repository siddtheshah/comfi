import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { executeAction, getPoolDetails, getSystemStatus } from './src/backend/localnet.js'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function testBackendApiPlugin(): Plugin {
  return {
    name: 'comfi-testing-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        
        if (url.pathname === '/api/status' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          try {
            const status = await getSystemStatus()
            return res.end(JSON.stringify(status))
          } catch (err: any) {
            res.statusCode = 500
            return res.end(JSON.stringify({ error: err.message || String(err) }))
          }
        }

        if (url.pathname === '/api/pool-details' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          const address = url.searchParams.get('address')
          if (!address) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Missing pool address parameter.' }))
          }
          try {
            const details = await getPoolDetails(address)
            return res.end(JSON.stringify(details))
          } catch (err: any) {
            res.statusCode = 500
            return res.end(JSON.stringify({ error: err.message || String(err) }))
          }
        }

        if (url.pathname === '/api/action' && req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json')
          let bodyStr = ''
          req.on('data', chunk => { bodyStr += chunk })
          req.on('end', async () => {
            try {
              const body = JSON.parse(bodyStr || '{}')
              if (!body.action) {
                res.statusCode = 400
                return res.end(JSON.stringify({ error: 'Missing action field in request body.' }))
              }
              const result = await executeAction(body.action, body.payload || {})
              return res.end(JSON.stringify({ success: true, result }))
            } catch (err: any) {
              res.statusCode = 400
              return res.end(JSON.stringify({ success: false, error: err.message || String(err), stack: err.stack }))
            }
          })
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  envDir: workspaceRoot,
  server: {
    port: 5174,
  },
  plugins: [react(), testBackendApiPlugin()],
})
