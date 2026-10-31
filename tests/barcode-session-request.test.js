import test from 'node:test'
import assert from 'node:assert/strict'
import { LAN_BARCODE_LOGIN_PATH, requestBarcodeSession } from '../src/cashier-pos/utils/barcodeSessionRequest.js'

const session = (source) => ({ ok: true, user: { id: 'cashier-1', token: `token-from-${source}` } })
const failure = (status, message = 'failed') => Object.assign(new Error(message), { status })

function harness({ lan, cloud }) {
  const calls = { lan: 0, cloud: 0 }
  return {
    calls,
    run: (options = {}) => requestBarcodeSession({
      barcode: '81000001',
      lan: async (barcode) => { calls.lan += 1; assert.equal(barcode, '81000001'); return lan() },
      cloud: async (barcode) => { calls.cloud += 1; assert.equal(barcode, '81000001'); return cloud() },
      ...options,
    }),
  }
}

test('the store server is asked first, and when it answers the cloud is never contacted', async () => {
  const h = harness({ lan: () => session('lan'), cloud: () => session('cloud') })
  const { result, via } = await h.run()
  assert.equal(via, 'lan')
  assert.equal(result.user.token, 'token-from-lan')
  assert.deepEqual(h.calls, { lan: 1, cloud: 0 })
})

test('route not installed (404): falls back to the cloud exactly as before the hook existed', async () => {
  const h = harness({ lan: () => { throw failure(404) }, cloud: () => session('cloud') })
  const { result, via } = await h.run()
  assert.equal(via, 'cloud')
  assert.equal(result.user.token, 'token-from-cloud')
})

test('store server unreachable / busy / limited / broken: all fall back to the cloud', async () => {
  for (const status of [0, 429, 500, 502, 503]) {
    const h = harness({ lan: () => { throw failure(status) }, cloud: () => session('cloud') })
    assert.equal((await h.run()).via, 'cloud', `status ${status}`)
  }
  const network = harness({ lan: () => { throw new TypeError('fetch failed') }, cloud: () => session('cloud') })
  assert.equal((await network.run()).via, 'cloud')
})

test('a 200 reply without a session token is not trusted: falls back to the cloud', async () => {
  for (const reply of [{ ok: true, user: {} }, { ok: true }, null, undefined, { user: { token: '' } }]) {
    const h = harness({ lan: () => reply, cloud: () => session('cloud') })
    assert.equal((await h.run()).via, 'cloud')
  }
})

test('401 from the store server is FINAL ("not an active cashier"): the cloud is not asked', async () => {
  const h = harness({ lan: () => { throw failure(401, 'Invalid cashier barcode.') }, cloud: () => session('cloud') })
  await assert.rejects(() => h.run(), (error) => error.status === 401 && /invalid cashier barcode/i.test(error.message))
  assert.deepEqual(h.calls, { lan: 1, cloud: 0 })
})

test('a 400 from the store server is not treated as final (could be a proxy or old route): the cloud decides', async () => {
  const h = harness({ lan: () => { throw failure(400) }, cloud: () => session('cloud') })
  assert.equal((await h.run()).via, 'cloud')
})

test('background retries can skip the cloud (to spare its shared 8-per-5-minutes login limit)', async () => {
  const h = harness({ lan: () => { throw failure(404) }, cloud: () => session('cloud') })
  await assert.rejects(() => h.run({ allowCloud: false }), (error) => error.status === 0 && error.cause?.status === 404)
  assert.deepEqual(h.calls, { lan: 1, cloud: 0 })
})

test('skipping the cloud still accepts a successful store-server answer', async () => {
  const h = harness({ lan: () => session('lan'), cloud: () => session('cloud') })
  assert.equal((await h.run({ allowCloud: false })).via, 'lan')
})

test("the cloud's own refusal reaches the caller unchanged (401 stays 401, outages keep their status)", async () => {
  const unauthorized = harness({ lan: () => { throw failure(404) }, cloud: () => { throw failure(401, 'Invalid cashier barcode.') } })
  await assert.rejects(() => unauthorized.run(), (error) => error.status === 401)
  const outage = harness({ lan: () => { throw failure(0) }, cloud: () => { throw failure(503) } })
  await assert.rejects(() => outage.run(), (error) => error.status === 503)
})

test('the route path matches the hook that the store server installs', async () => {
  assert.equal(LAN_BARCODE_LOGIN_PATH, '/api/nexa/barcode-login')
  const { readFile } = await import('node:fs/promises')
  const hook = await readFile(new URL('../pocketbase/pb_hooks/nexa_barcode_login.pb.js', import.meta.url), 'utf8')
  assert.ok(hook.includes(`routerAdd("POST", "${LAN_BARCODE_LOGIN_PATH}"`), 'client path and hook path must stay identical')
})
