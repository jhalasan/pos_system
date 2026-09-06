import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { AdminSyncEngine } from '../src/admin-page/offline/syncEngine.js'
import { rememberPocketBaseRateLimit, resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// sharedGovernor's rate-limit cooldown is ONE flag shared by every caller in
// the app -- including the unrelated Vercel-hosted /api/cashier/* calls
// (barcode login, manager approval) that still legitimately go to
// PocketHost and can still be rate-limited by it. A sync engine whose own
// `pb` targets a private-network server (the client's self-hosted
// PocketBase, which has no rate limit at all) must not have its own catalog
// refresh paused for minutes by a 429 that happened on that unrelated
// PocketHost-facing path.

function rateLimitError() {
  const err = new Error('Something went wrong.')
  err.status = 429
  return err
}

function fakeProductsPb(baseURL) {
  let productsListCalls = 0
  const fakePb = {
    baseURL,
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'products') {
        return {
          async getFullList() {
            productsListCalls += 1
            return []
          },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { fakePb, callCount: () => productsListCalls }
}

test('a cashier engine targeting a private-network server still refreshes its catalog while an unrelated PocketHost rate limit is active', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  rememberPocketBaseRateLimit(rateLimitError())

  const { fakePb, callCount } = fakeProductsPb('http://192.168.0.114:8090')
  const engine = new CashierSyncEngine({ baseUrl: 'http://192.168.0.114:8090', pb: fakePb })
  engine.stopped = false
  await engine.runSync({ forceProductRefresh: true, forceNetworkCheck: true })

  assert.equal(callCount(), 1, 'the local-server-bound catalog refresh must not be blocked by an unrelated rate limit')

  await cashierDb.delete()
  resetPocketBaseRateLimit()
})

test('a cashier engine still targeting PocketHost is correctly blocked by that same rate limit', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  rememberPocketBaseRateLimit(rateLimitError())

  const { fakePb, callCount } = fakeProductsPb('https://nexasystems.pockethost.io')
  const engine = new CashierSyncEngine({ baseUrl: 'https://nexasystems.pockethost.io', pb: fakePb })
  engine.stopped = false
  await engine.runSync({ forceProductRefresh: true, forceNetworkCheck: true })

  assert.equal(callCount(), 0, 'a PocketHost-facing engine must still honor the rate limit')

  await cashierDb.delete()
  resetPocketBaseRateLimit()
})

test('an admin engine targeting a private-network server pulls the cloud cache while an unrelated PocketHost rate limit is active', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()
  rememberPocketBaseRateLimit(rateLimitError())

  let categoriesCalls = 0
  const fakePb = {
    baseURL: 'http://192.168.0.114:8090',
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'categories') {
        return { async getFullList() { categoriesCalls += 1; return [] } }
      }
      if (name === 'products' || name === 'users' || name === 'authorization_barcodes') {
        return { async getFullList() { return [] } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }

  const engine = new AdminSyncEngine({ baseUrl: 'http://192.168.0.114:8090', pb: fakePb })
  engine.stopped = false
  await engine.runSync({ forceNetworkCheck: true })

  assert.ok(categoriesCalls > 0, 'the local-server-bound cloud pull must not be blocked by an unrelated rate limit')

  await adminDb.delete()
  resetPocketBaseRateLimit()
})
