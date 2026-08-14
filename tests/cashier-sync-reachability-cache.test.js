import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// Every sync cycle (every 60s, and again immediately after each completed
// sale) called isCloudReachable(), which hit pb.health.check() with no
// caching. Across several terminals ringing up sales back-to-back, that
// redundant round trip roughly doubled PocketHost request volume for no
// reason: admin-page/services/desktopApi.js already solved this with a
// short-lived reachability cache. This ports that pattern to the cashier.

function fakePb(healthCalls) {
  return {
    autoCancellation() {},
    health: {
      async check() {
        healthCalls.count += 1
      },
    },
  }
}

test('consecutive isCloudReachable calls within the cache window only hit health.check once', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

  const first = await engine.isCloudReachable()
  const second = await engine.isCloudReachable()
  const third = await engine.isCloudReachable()

  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(third, true)
  assert.equal(healthCalls.count, 1, 'a burst of reachability checks must only hit the network once')

  await cashierDb.delete()
})

test('forceNetworkCheck bypasses the reachability cache', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

  await engine.isCloudReachable()
  await engine.isCloudReachable({ forceNetworkCheck: true })

  assert.equal(healthCalls.count, 2, 'an explicit forced check must always hit the network')

  await cashierDb.delete()
})

test('a cached failure is also reused instead of hammering health.check while down', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const pb = {
    autoCancellation() {},
    health: {
      async check() {
        healthCalls.count += 1
        const err = new Error('fetch failed')
        throw err
      },
    },
  }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const first = await engine.isCloudReachable()
  const second = await engine.isCloudReachable()

  assert.equal(first, false)
  assert.equal(second, false)
  assert.equal(healthCalls.count, 1, 'a burst of checks while offline must only probe the network once')

  resetPocketBaseRateLimit()
  await cashierDb.delete()
})
