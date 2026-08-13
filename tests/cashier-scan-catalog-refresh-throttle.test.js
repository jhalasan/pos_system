import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { refreshLocalProductCatalog, resetProductCatalogRefreshThrottle } from '../src/cashier-pos/offline/cloudBootstrap.js'

// Scanning an already-cached item triggers a "keep it fresh" background
// catalog pull. Without a floor between pulls, ringing up a multi-item sale
// fired one full products.getFullList() per scan, which was blowing through
// PocketHost's request-rate limit and locking cashiers out of scanning/login.

function fakePb(listCalls) {
  return {
    autoCancellation() {},
    collection(name) {
      if (name === 'products') {
        return {
          async getFullList() {
            listCalls.count += 1
            return []
          },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
    files: { getURL: () => '' },
  }
}

test('background catalog refresh is throttled across repeated scans', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetProductCatalogRefreshThrottle()

  const listCalls = { count: 0 }
  const pb = fakePb(listCalls)
  const baseUrl = 'http://127.0.0.1:8090'

  await refreshLocalProductCatalog({ baseUrl, pb, background: true })
  await refreshLocalProductCatalog({ baseUrl, pb, background: true })
  await refreshLocalProductCatalog({ baseUrl, pb, background: true })

  assert.equal(listCalls.count, 1, 'a burst of scans must only pull the catalog once')
})

test('a forced (non-background) refresh still bypasses the throttle', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetProductCatalogRefreshThrottle()

  const listCalls = { count: 0 }
  const pb = fakePb(listCalls)
  const baseUrl = 'http://127.0.0.1:8090'

  await refreshLocalProductCatalog({ baseUrl, pb, background: true })
  await refreshLocalProductCatalog({ baseUrl, pb })

  assert.equal(listCalls.count, 2, 'an explicit refresh (cache miss, checkout, login) must not be throttled')
})
