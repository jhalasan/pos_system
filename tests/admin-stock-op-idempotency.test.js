import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { AdminSyncEngine } from '../src/admin-page/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// Root cause of a live "Stock In enters wrong/inflated quantity" report: the
// scanInventory/stockOutInventory/adjustInventoryCount op handlers wrote the
// new quantity to the cloud BEFORE checking whether this exact operation had
// already been applied -- that check only guarded the stock_movements audit
// record, not the quantity write itself. If the app closed/crashed between
// the cloud write succeeding and the local pendingOps row being deleted, the
// SAME op would be reprocessed on the next sync: it would re-read the
// cloud's now-already-updated quantity and add the delta a second time,
// while the audit trail quietly showed only one movement. These tests
// reproduce that exact replay scenario and confirm the pre-write check now
// prevents it.

const PRODUCT_ID = 'cloud-product-1'

function baseProductRecord(overrides = {}) {
  return {
    id: PRODUCT_ID,
    name: 'Marlboro Red Original',
    barcode: '4806504613212',
    quantity: 100,
    price: 10,
    ...overrides,
  }
}

function makeFakePb({ productRecord, existingMovement = null, existingMovements = [] } = {}) {
  const calls = { productUpdates: [], movementCreates: [] }
  let currentProduct = { ...productRecord }
  // reconcileProductStock (called after every new movement) recomputes the
  // quantity from the movement ledger and re-writes it if it disagrees with
  // the just-written value -- keep this in sync with currentProduct.quantity
  // via createStockMovement's own bookkeeping below so it's a no-op here.
  const movements = [...existingMovements]
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    files: { getURL: () => '' },
    collection(name) {
      if (name === 'products') {
        return {
          async getOne() { return { ...currentProduct } },
          async update(id, patch) {
            currentProduct = { ...currentProduct, ...patch }
            calls.productUpdates.push({ id, patch })
            return { ...currentProduct }
          },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFirstListItem() {
            if (!existingMovement) {
              const err = new Error('not found')
              err.status = 404
              throw err
            }
            return existingMovement
          },
          async create(payload) {
            calls.movementCreates.push(payload)
            const record = { id: `movement${String(calls.movementCreates.length).padStart(7, '0')}`, ...payload }
            movements.push(record)
            return record
          },
          async getList() {
            // Newest-first, matching reconcileProductStock's expected sort.
            return { items: [...movements].reverse() }
          },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, calls, getCurrentProduct: () => currentProduct }
}

function stockOp({ type, payload, ...overrides } = {}) {
  return {
    id: 'op-stockin-1',
    type,
    productId: PRODUCT_ID,
    payload,
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
    ...overrides,
  }
}

test('a fresh scanInventory op applies its delta once and records one movement', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const { pb, calls, getCurrentProduct } = makeFakePb({ productRecord: baseProductRecord({ quantity: 100 }) })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const op = stockOp({ type: 'scanInventory', payload: { qty: 50, barcode: '4806504613212' } })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  assert.equal(calls.productUpdates.length, 1, 'the quantity must be written exactly once')
  assert.equal(Number(getCurrentProduct().quantity), 150, '100 + 50 delta')
  assert.equal(calls.movementCreates.length, 1)
  assert.equal(await adminDb.pendingOps.get(op.id), undefined, 'the op must be cleared from the local queue')

  await adminDb.delete()
})

test('a scanInventory op whose cloud write already succeeded is not re-applied on replay', { concurrency: false }, async () => {
  // Simulates the exact crash window: the cloud's quantity already reflects
  // this op's delta (100 -> 150, applied on a previous attempt), and its
  // stock_movements record already exists -- but the local pendingOps row
  // was never cleared, so the sync engine picks the same op up again.
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const op = stockOp({ type: 'scanInventory', payload: { qty: 50, barcode: '4806504613212' } })
  const { pb, calls, getCurrentProduct } = makeFakePb({
    productRecord: baseProductRecord({ quantity: 150 }), // already includes this op's delta
    existingMovement: { id: 'movement0000001', reference_id: op.id, product_id: PRODUCT_ID },
  })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  assert.equal(calls.productUpdates.length, 0, 'a replayed op must NOT write the quantity again')
  assert.equal(getCurrentProduct().quantity, 150, 'quantity must stay at the already-correct value, not 200')
  assert.equal(calls.movementCreates.length, 0, 'no second movement should be created either')
  assert.equal(await adminDb.pendingOps.get(op.id), undefined, 'the stale local queue entry must still be cleared')

  await adminDb.delete()
})

test('a stockOutInventory op whose cloud write already succeeded is not re-applied on replay', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const op = stockOp({ id: 'op-stockout-1', type: 'stockOutInventory', payload: { qty: 20, barcode: '4806504613212' } })
  const { pb, calls, getCurrentProduct } = makeFakePb({
    productRecord: baseProductRecord({ quantity: 80 }), // already reflects this op's -20
    existingMovement: { id: 'movement0000002', reference_id: op.id, product_id: PRODUCT_ID },
  })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  assert.equal(calls.productUpdates.length, 0)
  assert.equal(getCurrentProduct().quantity, 80, 'quantity must stay at 80, not drop to 60')
  assert.equal(await adminDb.pendingOps.get(op.id), undefined)

  await adminDb.delete()
})
