import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// A store running several cashier terminals all started CashierSyncEngine
// on the same 60s cadence with no offset between them, so their periodic
// sync ticks tended to land in the same second and burst PocketHost at
// once. Each terminal now carries a small fixed jitter added to its
// steady-state interval so ticks spread out across the store instead of
// stacking.

function fakePb() {
  return { autoCancellation() {}, health: { async check() {} } }
}

function withStubbedTimeout(run) {
  const original = globalThis.setTimeout
  const calls = []
  globalThis.setTimeout = (fn, delay) => {
    calls.push(delay)
    return original(() => {}, 0) // never actually fire during the test
  }
  try {
    run(calls)
  } finally {
    globalThis.setTimeout = original
  }
}

test('jitterMs is stable per instance and within the documented range', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb() })

  assert.ok(Number.isInteger(engine.jitterMs))
  assert.ok(engine.jitterMs >= 0 && engine.jitterMs < 15_000)
  const first = engine.jitterMs
  assert.equal(engine.jitterMs, first, 'jitter must not be re-rolled between reads')

  await cashierDb.delete()
})

test('the steady-state schedule() call adds this instance\'s jitter to the base interval', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb() })
  engine.stopped = false

  withStubbedTimeout((calls) => {
    engine.schedule()
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 60_000 + engine.jitterMs)
  })

  withStubbedTimeout((calls) => {
    engine.schedule(0)
    assert.equal(calls[0], 0, 'an explicit immediate reschedule (startup, coming back online) must not be jittered')
  })

  if (engine.timer) clearTimeout(engine.timer)
  await cashierDb.delete()
})
