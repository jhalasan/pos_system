import assert from 'node:assert/strict'
import test from 'node:test'
import { activityLogPayloadForSync } from '../src/cashier-pos/offline/activityLogSync.js'

const queuedPayload = {
  user_id: 'stalecashier001',
  action_type: 'Login',
  description: 'Signed in offline',
  timestamp: '2026-07-13T06:00:00.000Z',
}

test('cashier activity-log sync drops a stale optional user relation', async () => {
  const payload = await activityLogPayloadForSync(queuedPayload, async () => '')

  assert.deepEqual(payload, {
    action_type: 'Login',
    description: 'Signed in offline',
    timestamp: '2026-07-13T06:00:00.000Z',
  })
  assert.equal(queuedPayload.user_id, 'stalecashier001')
})

test('cashier activity-log sync keeps an existing user relation', async () => {
  const payload = await activityLogPayloadForSync(queuedPayload, async (userId) => userId)

  assert.equal(payload.user_id, queuedPayload.user_id)
})
