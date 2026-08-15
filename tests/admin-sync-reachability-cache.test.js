import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { AdminSyncEngine } from '../src/admin-page/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// T1: the cashier sync engine already had a short-lived reachability cache
// (see cashier-sync-reachability-cache.test.js); the admin engine never did
// -- a plain health.check() ran on every single sync cycle, roughly
// doubling PocketHost request volume for no benefit. Ported the same
// pattern here.

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
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  try {
    await adminDb.delete()
    await initializeAdminDb()
    resetPocketBaseRateLimit()

    const healthCalls = { count: 0 }
    const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

    const first = await engine.isCloudReachable()
    const second = await engine.isCloudReachable()
    const third = await engine.isCloudReachable()

    assert.equal(first, true)
    assert.equal(second, true)
    assert.equal(third, true)
    assert.equal(healthCalls.count, 1, 'a burst of reachability checks must only hit the network once')

    await adminDb.delete()
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor)
  }
})

test('forceNetworkCheck bypasses the reachability cache', { concurrency: false }, async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  try {
    await adminDb.delete()
    await initializeAdminDb()
    resetPocketBaseRateLimit()

    const healthCalls = { count: 0 }
    const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

    await engine.isCloudReachable()
    await engine.isCloudReachable({ forceNetworkCheck: true })

    assert.equal(healthCalls.count, 2, 'an explicit forced check must always hit the network')

    await adminDb.delete()
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor)
  }
})

test('the online event resets the reachability cache', { concurrency: false }, async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  try {
    await adminDb.delete()
    await initializeAdminDb()
    resetPocketBaseRateLimit()

    const healthCalls = { count: 0 }
    // Engine is left stopped (its default) so handleOnline's own
    // this.schedule(0) call is a no-op and doesn't fire a real sync tick --
    // this test only cares about the reachability cache reset it also does.
    const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

    await engine.isCloudReachable()
    assert.equal(healthCalls.count, 1)

    engine.handleOnline()
    await engine.isCloudReachable()
    assert.equal(healthCalls.count, 2, 'coming back online must force a fresh check, not reuse a stale cached result')

    await adminDb.delete()
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor)
  }
})
