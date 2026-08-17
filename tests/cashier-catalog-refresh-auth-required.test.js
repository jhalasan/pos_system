import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'
import { resetProductCatalogRefreshThrottle } from '../src/cashier-pos/offline/cloudBootstrap.js'

// M14: a catalog refresh that failed specifically because the session token
// expired used to be indistinguishable from any other refresh failure --
// both surfaced as a generic "Product catalog could not refresh: <raw
// error>" waiting-state message (often literally "Something went wrong"),
// never routing the cashier to the same fix (the interactive re-auth popup)
// that a queued-write hitting the identical root cause already used.

// syncNow's `forceNetworkCheck: true` below is a test-environment
// workaround, not part of what's being verified: Node's built-in
// `navigator` global exists but leaves `navigator.onLine` undefined, which
// isCloudReachable's very first check reads as "offline" and returns early
// before ever reaching the code under test. Real browsers/Tauri's webview
// always have a real boolean there.
function authError(status) {
  const err = new Error(status === 401 ? 'Something went wrong.' : 'Internal error.')
  err.status = status
  return err
}

function makeFakePb({ refreshError, authStoreValid = false }) {
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    authStore: { isValid: authStoreValid },
    health: { async check() { return { ok: true } } },
    collection(name) {
      if (name === 'products') {
        return { async getFullList() { throw refreshError } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return pb
}

test('a catalog refresh that fails with a 401 is reported as auth-required, not a generic refresh error', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  resetProductCatalogRefreshThrottle()

  const pb = makeFakePb({ refreshError: authError(401) })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const result = await engine.syncNow({ forceNetworkCheck: true })

  assert.match(result.warnings[0], /no cloud authorization/i, 'the warning must route through the same auth-required message, not the raw PocketBase error text')

  await cashierDb.delete()
})

test('a catalog refresh that fails for an unrelated reason (not 401, token still valid) keeps the generic message', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  resetProductCatalogRefreshThrottle()

  const pb = makeFakePb({ refreshError: authError(500), authStoreValid: true })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const result = await engine.syncNow({ forceNetworkCheck: true })

  assert.doesNotMatch(result.warnings[0], /no cloud authorization/i, 'a genuine non-auth failure must not be misreported as an expired session')

  await cashierDb.delete()
})
