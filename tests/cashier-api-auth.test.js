import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

// Regression coverage for the S3 fix: /api/cashier/* routes used to bypass
// the auth middleware entirely (server/index.js used to short-circuit on
// req.path.startsWith('/cashier/') before any token check ran), so anyone
// who could reach the Express port could ring sales, void transactions, and
// brute-force manager approval barcodes with no credentials at all.

delete process.env.VERCEL
delete process.env.ADMIN_WEB_ONLY
process.env.AUTO_BACKUP_ENABLED = 'false'

let server
let baseUrl

before(async () => {
  const { default: app } = await import('../server/index.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (!server) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('POST /api/cashier/sales rejects requests with no token', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(response.status, 401)
})

test('POST /api/cashier/authorize-void rejects requests with no token', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/authorize-void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '9200000001' }),
  })
  assert.equal(response.status, 401)
})

test('POST /api/cashier/auth/login rejects an empty-credentials request before touching PocketBase', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '', password: '' }),
  })
  // Missing credentials -> 400, not 401 -- proves the route itself is
  // reachable and doing its own validation, not blocked by the auth gate
  // that guards every other /cashier/* route.
  assert.equal(response.status, 400)
})
