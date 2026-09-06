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

// Root cause of a live "Stock In enters a different quantity than what was
// counted" report: reconcileProductStock (called from inside
// createStockMovement) already self-heals PocketBase's true quantity when
// two terminals race off the same stale baseline -- see
// stockMovementReconciler.js's own comment on why delta-summation handles
// this correctly. But the caller kept using `updated`, the product object
// captured from the WRITE THAT HAPPENED BEFORE that self-correction ran, to
// populate the local (Dexie) cache the admin's own screen reads from. The
// cloud's true number was already fixed; the screen just never found out.
//
// Simulated here via an existing stock_movement whose chain no longer
// matches the current cloud quantity (exactly what a concurrent race
// produces): the movement says {previous: 20, new: 500}, but the cloud's
// current quantity is 400 (as if a second, later write clobbered it).
// Processing one more +10 scanInventory op must leave the LOCAL cache at
// the correctly-reconciled 510 (20 baseline + 480 existing delta + 10 new
// delta), not the pre-reconcile 410 the raw write itself returned.
test('the local cache reflects reconcileProductStock\'s correction, not the pre-reconcile write result', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const op = stockOp({ type: 'scanInventory', payload: { qty: 10, barcode: '4806504613212' } })
  const { pb, calls, getCurrentProduct } = makeFakePb({
    productRecord: baseProductRecord({ quantity: 400 }),
    existingMovements: [
      {
        id: 'movement0000001',
        product_id: PRODUCT_ID,
        movement_type: 'stock_in',
        quantity: 480,
        previous_quantity: 20,
        new_quantity: 500,
        reference_type: 'scanInventory',
        reference_id: 'op-other-terminal',
        created: '2026-08-19T16:04:00.000Z',
      },
    ],
  })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  await adminDb.products.put({ id: PRODUCT_ID, name: 'Marlboro Red Original', barcode: '4806504613212', qty: 400, price: 10 })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  // reconcileProductStock's own delta-summation: 20 + 480 + 10 = 510.
  assert.equal(Number(getCurrentProduct().quantity), 510, "PocketBase's own true quantity must be the reconciled total")
  const localProduct = await adminDb.products.get(PRODUCT_ID)
  assert.equal(localProduct.qty, 510, "the admin's local cache (what the Inventory screen displays) must match the reconciled total, not the raw pre-reconcile write result of 410")

  await adminDb.delete()
})

test('the same fix applies to stockOutInventory', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const op = stockOp({ type: 'stockOutInventory', payload: { qty: 10, barcode: '4806504613212' } })
  const { pb, getCurrentProduct } = makeFakePb({
    productRecord: baseProductRecord({ quantity: 400 }),
    existingMovements: [
      {
        id: 'movement0000001',
        product_id: PRODUCT_ID,
        movement_type: 'stock_in',
        quantity: 480,
        previous_quantity: 20,
        new_quantity: 500,
        reference_type: 'scanInventory',
        reference_id: 'op-other-terminal',
        created: '2026-08-19T16:04:00.000Z',
      },
    ],
  })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  await adminDb.products.put({ id: PRODUCT_ID, name: 'Marlboro Red Original', barcode: '4806504613212', qty: 400, price: 10 })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  // 20 baseline + 480 existing delta - 10 this op's delta = 490.
  assert.equal(Number(getCurrentProduct().quantity), 490)
  const localProduct = await adminDb.products.get(PRODUCT_ID)
  assert.equal(localProduct.qty, 490, 'local cache must match the reconciled total, not the raw write result of 390')

  await adminDb.delete()
})

// adjustInventoryCount (Stock Count) is DELIBERATELY NOT reconciled the same
// way as scanInventory/stockOutInventory -- see syncEngine.js's
// createStockMovement comment. A physical count declares the new ground
// truth; unlike a stock-in/stock-out race, there is no "true intended value"
// to recover by delta-summing movement history, because the count itself
// supersedes that history. Confirmed via a live incident: a real Stock Count
// wrote previous_quantity=180, new_quantity=360, and the (since-removed)
// reconcile-after-adjustment call silently re-derived it to 366 from a
// movement window carrying pre-existing concurrent-sale chain drift -- the
// counted value never reached the screen. This test used to assert that
// same drift-prone behavior as "the fix" (matching scanInventory's math);
// it was actually the bug. It now asserts the count sticks.
test('adjustInventoryCount (Stock Count) always applies the counted value as-is, even with unrelated concurrent movement drift in history', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  const op = stockOp({ type: 'adjustInventoryCount', payload: { countedQty: 410 } })
  const { pb, getCurrentProduct } = makeFakePb({
    productRecord: baseProductRecord({ quantity: 400 }),
    existingMovements: [
      {
        id: 'movement0000001',
        product_id: PRODUCT_ID,
        movement_type: 'stock_in',
        quantity: 480,
        previous_quantity: 20,
        new_quantity: 500,
        reference_type: 'scanInventory',
        reference_id: 'op-other-terminal',
        created: '2026-08-19T16:04:00.000Z',
      },
    ],
  })
  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  await adminDb.products.put({ id: PRODUCT_ID, name: 'Marlboro Red Original', barcode: '4806504613212', qty: 400, price: 10 })
  await adminDb.pendingOps.put(op)

  await engine.uploadOperation(op)

  // The counted value (410) is applied exactly -- unrelated movement history
  // (the other terminal's stock_in) must never pull it off that value.
  assert.equal(Number(getCurrentProduct().quantity), 410)
  const localProduct = await adminDb.products.get(PRODUCT_ID)
  assert.equal(localProduct.qty, 410, 'local cache must match the physically counted quantity, not a value re-derived from unrelated movement history')

  await adminDb.delete()
})
