import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// M1: a refund/exchange used to only ever flip sales.status to "adjusted"
// in the cloud -- the amount, items, reason, and approver existed only in
// the terminal's local Dexie DB. uploadOperation now also writes a durable
// sale_adjustments record (keyed by adjustment_id, the same idempotency
// anchor the terminal already generates locally) and sets
// sales.refunded_amount/refunded_units to the sum of every sale_adjustments
// record for that sale (recomputed from the ledger, not incremented from a
// single stale read -- see the "two concurrent refunds" test below for why)
// -- total_amount itself is never touched.

const CASHIER_ID = 'abc123cashier01'

function makeFakePb({ existingAdjustment = null, existingLedger = [], saleRecord } = {}) {
  const created = { sale_adjustments: [], salesUpdates: [] }
  // The full ledger this fake "cloud" already holds for the sale, plus
  // anything created during this call -- getFullList reads from here so the
  // recompute-from-ledger fix can be exercised the same way the real
  // sale_adjustments collection would behave.
  const ledger = [...existingLedger]
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'sales') {
        return {
          async getFirstListItem() { return saleRecord },
          async update(id, patch) { created.salesUpdates.push({ id, patch }); return { id, ...patch } },
        }
      }
      if (name === 'sale_adjustments') {
        return {
          async getFirstListItem() {
            if (!existingAdjustment) {
              const err = new Error('not found')
              err.status = 404
              throw err
            }
            return existingAdjustment
          },
          async create(payload) {
            const record = { id: 'adjustment0000001', ...payload }
            created.sale_adjustments.push(payload)
            ledger.push(record)
            return record
          },
          async getFullList() { return ledger },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, created }
}

function adjustOp({ payload: payloadOverrides = {}, ...overrides } = {}) {
  return {
    id: 'op-adjust-1',
    type: 'adjustCompletedSale',
    entityId: 'sale-1',
    payload: {
      transactionNo: 'TXN-1',
      cashierId: CASHIER_ID,
      approverId: '',
      type: 'refund',
      items: [{ productId: 'product-1', quantity: 1, conversion: 1, price: 100 }],
      reason: 'Wrong item',
      note: '',
      restock: false, // keep the test focused on the reporting write, not restock
      createdAt: '2026-08-15T10:00:00.000Z',
      adjustmentId: 'adjustment-uuid-1',
      amount: 100,
      ...payloadOverrides,
    },
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
    ...overrides,
  }
}

test('a new refund creates a sale_adjustments record and increments refunded_amount/units additively', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const saleRecord = { id: 'cloudsale1', transaction_no: 'TXN-1', cashier_id: CASHIER_ID, total_amount: 500, refunded_amount: 0, refunded_units: 0 }
  const { pb, created } = makeFakePb({ saleRecord })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadOperation(adjustOp())

  assert.equal(created.sale_adjustments.length, 1)
  assert.equal(created.sale_adjustments[0].adjustment_id, 'adjustment-uuid-1')
  assert.equal(created.sale_adjustments[0].amount, '100')
  assert.equal(created.sale_adjustments[0].sale_id, 'cloudsale1')

  const refundTotalsUpdate = created.salesUpdates.find((u) => 'refunded_amount' in u.patch)
  assert.ok(refundTotalsUpdate, 'refunded_amount must be written to the sale')
  assert.equal(refundTotalsUpdate.patch.refunded_amount, '100')
  assert.equal(refundTotalsUpdate.patch.refunded_units, '1')

  // total_amount is never in any update payload -- it must never be mutated.
  for (const update of created.salesUpdates) {
    assert.equal('total_amount' in update.patch, false, 'total_amount must never be touched by a refund')
  }

  await cashierDb.delete()
})

test('a retried upload of the same adjustment_id does not double-count refunded_amount', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const saleRecord = { id: 'cloudsale1', transaction_no: 'TXN-1', cashier_id: CASHIER_ID, total_amount: 500, refunded_amount: 100, refunded_units: 1 }
  const { pb, created } = makeFakePb({
    saleRecord,
    existingAdjustment: { id: 'adjustment0000001', adjustment_id: 'adjustment-uuid-1' },
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadOperation(adjustOp())

  assert.equal(created.sale_adjustments.length, 0, 'an already-recorded adjustment must not be created again')
  assert.equal(created.salesUpdates.some((u) => 'refunded_amount' in u.patch), false, 'refunded_amount must not be incremented again for a retry')

  await cashierDb.delete()
})

test('a second, different refund on the same sale adds to the existing refunded_amount rather than replacing it', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  // This sale already has a prior refund of 100 recorded in the ledger.
  const saleRecord = { id: 'cloudsale1', transaction_no: 'TXN-1', cashier_id: CASHIER_ID, total_amount: 500, refunded_amount: 100, refunded_units: 1 }
  const { pb, created } = makeFakePb({
    saleRecord,
    existingLedger: [{ sale_id: 'cloudsale1', adjustment_id: 'adjustment-uuid-1', amount: 100, items: [{ quantity: 1 }] }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadOperation(adjustOp({ payload: { adjustmentId: 'adjustment-uuid-2', amount: 50 } }))

  const refundTotalsUpdate = created.salesUpdates.find((u) => 'refunded_amount' in u.patch)
  assert.equal(refundTotalsUpdate.patch.refunded_amount, '150', 'must add to the existing 100, not replace it')

  await cashierDb.delete()
})

test('two concurrent refunds on the same sale both land instead of one clobbering the other', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  // Reproduces the fixed race: two terminals each refund a different line
  // of the same sale. Before the fix, each computed
  // sale.refunded_amount + its own amount from the SAME stale read of
  // refunded_amount: 0, so whichever write landed last silently dropped the
  // other's contribution. The fix recomputes from the full sale_adjustments
  // ledger, which by the time the second op runs already contains the
  // first op's record.
  const saleRecord = { id: 'cloudsale1', transaction_no: 'TXN-1', cashier_id: CASHIER_ID, total_amount: 500, refunded_amount: 0, refunded_units: 0 }
  const { pb, created } = makeFakePb({ saleRecord })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadOperation(adjustOp({ payload: { adjustmentId: 'adjustment-uuid-A', amount: 100 } }))
  await engine.uploadOperation(adjustOp({ payload: { adjustmentId: 'adjustment-uuid-B', amount: 75 } }))

  const refundTotalsUpdates = created.salesUpdates.filter((u) => 'refunded_amount' in u.patch)
  assert.equal(refundTotalsUpdates.length, 2)
  assert.equal(refundTotalsUpdates[0].patch.refunded_amount, '100')
  assert.equal(refundTotalsUpdates[1].patch.refunded_amount, '175', 'the second refund must reflect both refunds, not just its own 75')

  await cashierDb.delete()
})
