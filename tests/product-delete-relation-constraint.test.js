import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { AdminSyncEngine } from '../src/admin-page/offline/syncEngine.js'

// A product that has ever been sold or had a stock movement is referenced by
// PocketBase relation fields (sale_items.product_id, stock_movements.product_id),
// so a hard `products.delete()` against it is rejected with a relation-
// constraint error. That used to be caught and silently treated as success:
// the product was marked deleted only in the terminal's own local cache while
// the cloud record stayed fully live, so it would reappear the moment any
// device (or this one, after a cache reset) pulled a fresh catalog. Delete
// must now fall back to marking the cloud record 'deleted' instead of lying
// about it -- and 'deleted' on purpose, not 'archived': the client pointed
// out that reusing Archive's status made Delete indistinguishable from the
// separate Archive button, so they need their own distinct outcome.

function relationConstraintError() {
  const err = new Error('Failed to delete record. Failed to resolve required relation reference.')
  err.status = 400
  return err
}

test('deleteProduct falls back to a durable, distinct "deleted" cloud status when hard delete is blocked by a relation constraint', async () => {
  await adminDb.delete()
  await initializeAdminDb()

  await adminDb.products.put({
    id: 'p1', name: 'Widget', barcode: '123', qty: 5, price: 10,
    lifecycleStatus: 'active', deleted: false, pendingSync: true, updated: new Date().toISOString(),
  })
  await adminDb.pendingOps.put({
    id: 'op1', type: 'deleteProduct', productId: 'p1', payload: { id: 'p1' },
    status: 'pending', attempts: 0, lastError: '', nextAttemptAt: 0, createdAt: Date.now(),
  })

  let updateCalls = 0
  const fakePb = {
    autoCancellation() {},
    collection(name) {
      if (name !== 'products') throw new Error(`Unexpected collection: ${name}`)
      return {
        async delete() { throw relationConstraintError() },
        async update(id, data) {
          updateCalls += 1
          assert.equal(id, 'p1')
          assert.deepEqual(data, { lifecycle_status: 'deleted' })
          return { id: 'p1', name: 'Widget', barcode: '123', quantity: 5, price: 10, lifecycle_status: 'deleted' }
        },
      }
    },
  }

  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb })
  await engine.uploadOperation({ id: 'op1', type: 'deleteProduct', productId: 'p1', payload: { id: 'p1' } })

  assert.equal(updateCalls, 1, 'must mark the cloud record deleted instead of no-opping')

  const stored = await adminDb.products.get('p1')
  assert.equal(stored.lifecycleStatus, 'deleted')
  assert.notEqual(stored.lifecycleStatus, 'archived', 'delete must be a distinct outcome from the separate Archive action')
  assert.equal(stored.deleted, false, '"deleted" lifecycle status is the durable state -- not the fragile local-only "deleted" tombstone flag')

  const pendingOp = await adminDb.pendingOps.get('op1')
  assert.equal(pendingOp, undefined, 'the op must not be left queued for endless retry')
})

test('deleteProduct still performs a genuine hard delete when nothing references the product', async () => {
  await adminDb.delete()
  await initializeAdminDb()

  await adminDb.products.put({
    id: 'p2', name: 'Never Sold', barcode: '456', qty: 5, price: 10,
    lifecycleStatus: 'active', deleted: false, pendingSync: true, updated: new Date().toISOString(),
  })
  await adminDb.pendingOps.put({
    id: 'op2', type: 'deleteProduct', productId: 'p2', payload: { id: 'p2' },
    status: 'pending', attempts: 0, lastError: '', nextAttemptAt: 0, createdAt: Date.now(),
  })

  let deleteCalls = 0
  const fakePb = {
    autoCancellation() {},
    collection(name) {
      if (name !== 'products') throw new Error(`Unexpected collection: ${name}`)
      return {
        async delete(id) { deleteCalls += 1; assert.equal(id, 'p2') },
        async update() { throw new Error('must not archive when the hard delete already succeeded') },
      }
    },
  }

  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb })
  await engine.uploadOperation({ id: 'op2', type: 'deleteProduct', productId: 'p2', payload: { id: 'p2' } })

  assert.equal(deleteCalls, 1)
  const stored = await adminDb.products.get('p2')
  assert.equal(stored.deleted, true)

  const pendingOp = await adminDb.pendingOps.get('op2')
  assert.equal(pendingOp, undefined)
})
