import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { refreshLocalProductCatalog, resetProductCatalogRefreshThrottle } from '../src/cashier-pos/offline/cloudBootstrap.js'

// Task 1 removed a redundant health.check() from most sync cycles, which
// buys headroom to also widen the two existing polling floors (background
// scan-triggered refresh, and the sync engine's own periodic catalog
// refresh) so a busy store makes noticeably fewer catalog-refresh requests
// per hour without the catalog going meaningfully staler.

function fakePb(listCalls) {
  return {
    autoCancellation() {},
    collection(name) {
      if (name === 'products') {
        return { async getFullList() { listCalls.count += 1; return [] } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
    files: { getURL: () => '' },
  }
}

test('background refresh floor is at least 3 minutes', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetProductCatalogRefreshThrottle()

  const listCalls = { count: 0 }
  const pb = fakePb(listCalls)
  const baseUrl = 'http://127.0.0.1:8090'

  await refreshLocalProductCatalog({ baseUrl, pb, background: true })

  const realNow = Date.now
  Date.now = () => realNow() + 2 * 60_000 + 30_000 // 2m30s later — inside the old 60s floor's "long expired" range, but must still be throttled under the new floor
  try {
    await refreshLocalProductCatalog({ baseUrl, pb, background: true })
  } finally {
    Date.now = realNow
  }

  assert.equal(listCalls.count, 1, 'a background refresh 2m30s after the last one must still be throttled under a >=3min floor')
})
