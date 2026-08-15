import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localAdjustmentsNotYetSynced, refundedAmountAndUnits } from '../src/utils/localSaleAdjustments.js'

// M1, Tauri admin dashboard: the desktop admin app computes its own
// dashboard/FSN figures independently of the Express /api/dashboard route
// fixed earlier, merging local (not-yet-synced) sales with cloud
// PocketBase records. These helpers bridge a local sale's inline
// adjustments[] array with the cloud's separate sale_adjustments
// collection so refunds net out correctly regardless of sync state, and
// are never double-counted once a refund actually syncs.

test('refundedAmountAndUnits sums amount and item quantities across adjustments', () => {
  const result = refundedAmountAndUnits([
    { amount: 100, items: [{ productId: 'p1', quantity: 2 }] },
    { amount: 50, items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 3 }] },
  ])
  assert.equal(result.refundedAmount, 150)
  assert.equal(result.refundedUnits, 6)
})

test('refundedAmountAndUnits handles missing or empty input', () => {
  assert.deepEqual(refundedAmountAndUnits([]), { refundedAmount: 0, refundedUnits: 0 })
  assert.deepEqual(refundedAmountAndUnits(undefined), { refundedAmount: 0, refundedUnits: 0 })
  assert.deepEqual(refundedAmountAndUnits([{ amount: 10 }]), { refundedAmount: 10, refundedUnits: 0 })
})

test('localAdjustmentsNotYetSynced converts a local sale\'s adjustments to cloud-shaped entries', () => {
  const localSales = [{
    clientSaleId: 'local-1',
    adjustments: [{ id: 'adj-1', items: [{ productId: 'p1', quantity: 2 }] }],
  }]
  const result = localAdjustmentsNotYetSynced(localSales, [])
  assert.equal(result.length, 1)
  assert.equal(result[0].sale_id, 'local-1')
  assert.deepEqual(result[0].items, [{ productId: 'p1', quantity: 2 }])
})

test('localAdjustmentsNotYetSynced excludes an adjustment already present in the cloud list', () => {
  const localSales = [{
    clientSaleId: 'local-1',
    adjustments: [
      { id: 'adj-synced', items: [{ productId: 'p1', quantity: 2 }] },
      { id: 'adj-pending', items: [{ productId: 'p2', quantity: 1 }] },
    ],
  }]
  const cloudAdjustments = [{ adjustment_id: 'adj-synced', sale_id: 'cloud-1', items: [] }]
  const result = localAdjustmentsNotYetSynced(localSales, cloudAdjustments)
  assert.equal(result.length, 1)
  assert.equal(result[0].sale_id, 'local-1')
  assert.deepEqual(result[0].items, [{ productId: 'p2', quantity: 1 }])
})

test('localAdjustmentsNotYetSynced falls back through id fields for the sale reference', () => {
  const localSales = [
    { clientSaleId: 'a', adjustments: [{ id: '1', items: [] }] },
    { id: 'b', adjustments: [{ id: '2', items: [] }] },
    { transactionNo: 'c', adjustments: [{ id: '3', items: [] }] },
  ]
  const result = localAdjustmentsNotYetSynced(localSales, [])
  assert.deepEqual(result.map((entry) => entry.sale_id), ['a', 'b', 'c'])
})

test('localAdjustmentsNotYetSynced handles sales with no adjustments and malformed input gracefully', () => {
  assert.deepEqual(localAdjustmentsNotYetSynced([{ clientSaleId: 'x' }], []), [])
  assert.deepEqual(localAdjustmentsNotYetSynced([], []), [])
  assert.deepEqual(localAdjustmentsNotYetSynced(null, null), [])
})
