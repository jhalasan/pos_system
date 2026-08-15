import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.VERCEL = '1'
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

test('remote admin API rejects protected requests without a token', async () => {
  const response = await fetch(`${baseUrl}/api/products`)
  assert.equal(response.status, 401)
})

test('remote admin deployment does not expose cashier services', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/products`)
  assert.equal(response.status, 404)
})

test('remote admin deployment still does not expose cashier sales history', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/sales`)
  assert.equal(response.status, 404)
})

// S1's server-mediated barcode-login/manager-approval verify must stay
// reachable on the remote admin portal: the desktop cashier app talks to
// PocketBase directly for everything else (no other server exists in this
// deployment's topology, see VERCEL_DEPLOYMENT.md), so these are the only
// /cashier/* endpoints it can call. An empty body fails validation before
// either route ever touches PocketBase, so this stays a network-independent
// check on reachability (non-404), not a real-credential integration test.
test('remote admin deployment still answers barcode-login verification', async () => {
  const response = await fetch(`${baseUrl}/api/cashier/auth/barcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.notEqual(response.status, 404)
  assert.equal(response.status, 400)
})

test('remote admin deployment still answers manager-approval verification', async () => {
  // authorize-void requires the caller's own cashier bearer token (S3) --
  // in production that's the already-logged-in cashier's real PocketBase
  // session token. With none supplied here, the auth-token gate rejects it
  // with 401 before ever reaching the route's own validation -- the point
  // of this test is that it's reachable at all (not 404 from the earlier
  // Vercel admin-only gate), not the exact downstream status.
  const response = await fetch(`${baseUrl}/api/cashier/authorize-void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.notEqual(response.status, 404)
  assert.equal(response.status, 401)
})

test('remote admin deployment does not expose the development PocketBase proxy', async () => {
  const response = await fetch(`${baseUrl}/api/pocketbase/health`)
  assert.equal(response.status, 401)
})
