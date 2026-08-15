import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

// S4: the deployed support-ticket endpoint used to have
// Access-Control-Allow-Origin: '*', no rate limit, and no attachment type
// filter -- an open, unauthenticated mail relay through the business's own
// SMTP credential, reachable by anyone who found the URL. These tests drive
// the actual standalone Vercel function (not the Express app) directly over
// a real HTTP server, the same way it's invoked in production.

process.env.SMTP_HOST = ''
process.env.CLIENT_ORIGIN = 'https://example-admin.vercel.app'

let server
let baseUrl

// Vercel's Node runtime decorates the response with .status()/.json() on top
// of the plain http.ServerResponse; a raw node:http server doesn't have
// those, so the handler would throw before ever reaching the code under
// test. This reproduces just enough of that contract to drive the real
// handler the way production actually invokes it.
function withVercelResponseHelpers(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
    return res
  }
  return res
}

before(async () => {
  const { default: handler } = await import('../api/support/tickets.js')
  server = http.createServer((req, res) => {
    handler(req, withVercelResponseHelpers(res)).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (!server) return
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

test('does not grant a disallowed cross-origin caller access', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: new FormData(),
  })
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('allows the desktop (Tauri) app origin', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Origin: 'tauri://localhost' },
    body: new FormData(),
  })
  assert.equal(response.headers.get('access-control-allow-origin'), 'tauri://localhost')
})

test('allows a configured CLIENT_ORIGIN', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Origin: 'https://example-admin.vercel.app' },
    body: new FormData(),
  })
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example-admin.vercel.app')
})

test('rejects a non-image attachment', async () => {
  const body = new FormData()
  body.append('id', 'NEXA-TEST')
  body.append('description', 'test ticket')
  body.append('attachments', new Blob(['not an image'], { type: 'application/octet-stream' }), 'payload.bin')
  const response = await fetch(baseUrl, { method: 'POST', body })
  assert.equal(response.status, 415)
  const json = await response.json()
  assert.match(json.error, /JPEG, PNG, or WEBP/)
})

test('rate limits repeated requests from the same connection', async () => {
  const statuses = []
  for (let i = 0; i < 15; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(baseUrl, { method: 'POST', body: new FormData() })
    statuses.push(response.status)
  }
  assert.ok(statuses.includes(429), `expected at least one 429 among: ${statuses.join(',')}`)
})
