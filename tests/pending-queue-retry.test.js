import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { forceRetryNow } from '../src/utils/pendingQueueRetry.js'

// T1: a manual "Sync" click (and, separately, every cashier login) used to
// wipe every queued row's `attempts` counter back to 0 alongside
// nextAttemptAt. That defeats the whole point of the counter -- an op one
// failure away from being dead-lettered (so someone could actually see and
// deal with it) got fully resurrected by a sync click, and would take
// another MAX_ATTEMPTS failures to reach that point again.

async function seedOp(overrides = {}) {
  await adminDb.pendingOps.put({
    id: overrides.id || 'op-1',
    type: 'updateProduct',
    productId: 'product-1',
    payload: {},
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
    ...overrides,
  })
}

test('forceRetryNow never touches attempts', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()

  await seedOp({ id: 'op-1', status: 'failed', attempts: 9, nextAttemptAt: Date.now() + 10 * 60_000 })
  await forceRetryNow(adminDb.pendingOps)

  const row = await adminDb.pendingOps.get('op-1')
  assert.equal(row.attempts, 9, 'attempts must survive a forced retry unchanged')
  assert.equal(row.status, 'pending', 'a failed row is made eligible again')

  await adminDb.delete()
})

test('forceRetryNow clears nextAttemptAt only when it is genuinely far out (>60s)', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()

  const now = Date.now()
  await seedOp({ id: 'op-soon', status: 'pending', nextAttemptAt: now + 5_000 })
  await seedOp({ id: 'op-far', status: 'pending', nextAttemptAt: now + 10 * 60_000 })
  await forceRetryNow(adminDb.pendingOps)

  const soon = await adminDb.pendingOps.get('op-soon')
  const far = await adminDb.pendingOps.get('op-far')
  assert.equal(soon.nextAttemptAt, now + 5_000, 'a row already due soon must be left alone, not touched')
  assert.notEqual(far.nextAttemptAt, now + 10 * 60_000, 'a row genuinely far out must be pulled forward to retry now')

  await adminDb.delete()
})

test('forceRetryNow leaves a row already due (nextAttemptAt in the past) untouched', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()

  const pastValue = Date.now() - 5_000
  await seedOp({ id: 'op-due', status: 'pending', nextAttemptAt: pastValue })
  await forceRetryNow(adminDb.pendingOps)

  const row = await adminDb.pendingOps.get('op-due')
  assert.equal(row.nextAttemptAt, pastValue, 'already-due rows need no change -- they are already eligible on the next tick')

  await adminDb.delete()
})
