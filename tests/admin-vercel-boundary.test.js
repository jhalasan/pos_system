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

test('remote admin deployment does not expose the development PocketBase proxy', async () => {
  const response = await fetch(`${baseUrl}/api/pocketbase/health`)
  assert.equal(response.status, 401)
})
