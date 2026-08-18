import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { AdminSyncEngine } from '../src/admin-page/offline/syncEngine.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// A bulk delete/edit that trips PocketHost's per-IP rate limit must not drain
// the whole pending-ops queue, must not burn retry attempts on the ops it
// never got to run, and must surface a clear "rate limited" message instead
// of the PocketBase SDK's generic "Something went wrong." default.

function rateLimitError() {
  const err = new Error('Something went wrong.')
  err.status = 429
  return err
}

function fieldError(field, message) {
  const err = new Error('Failed to update record.')
  err.status = 400
  err.response = { data: { [field]: { message } } }
  return err
}

test('admin product edits never overwrite cloud stock with a stale cached quantity', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()

  let updateBody
  const cloudProduct = {
    id: 'product1',
    name: 'Coffee',
    barcode: '1001',
    category: '',
    quantity: 25,
    base_unit: 'Piece',
    min_stock: 5,
    price: 10,
    updated: '2026-08-18 10:00:00.000Z',
  }
  const fakePb = {
    autoCancellation() {},
    files: { getURL: () => '' },
    collection(name) {
      assert.equal(name, 'products')
      return {
        async getOne() { return cloudProduct },
        async update(_id, body) {
          updateBody = body
          return { ...cloudProduct, ...body, quantity: cloudProduct.quantity }
        },
      }
    },
  }
  const localProduct = {
    id: 'product1', name: 'Coffee', barcode: '1001', categoryId: '', qty: 10,
    unit: 'Piece', lowStock: 5, price: 12, pendingSync: true,
  }
  const op = {
    id: 'op-product-edit', type: 'updateProduct', productId: 'product1',
    payload: { ...localProduct, baseUpdated: '2026-08-18 10:00:00.000Z' },
    status: 'pending', attempts: 0, createdAt: Date.now(),
  }
  await adminDb.products.put(localProduct)
  await adminDb.pendingOps.put(op)

  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb })
  await engine.uploadOperation(op)

  assert.equal(Object.hasOwn(updateBody, 'quantity'), false)
  assert.equal(updateBody.price, 12)
  assert.equal((await adminDb.products.get('product1')).qty, 25)
  await adminDb.delete()
})

test('admin drain loop halts on 429, does not dead-letter, and skips the catalog pull', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  resetPocketBaseRateLimit()

  let deleteCalls = 0
  let productsListCalls = 0
  const fakePb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'products') {
        return {
          async delete() {
            deleteCalls += 1
            if (deleteCalls === 1) throw fieldError('name', 'Name is required.')
            throw rateLimitError()
          },
          async getFullList() {
            productsListCalls += 1
            return []
          },
        }
      }
      if (name === 'activity_logs') {
        return { async create() { return { id: 'log1' } } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }

  const now = Date.now()
  const ops = [1, 2, 3, 4, 5].map((n) => ({
    id: `op${n}`,
    type: 'deleteProduct',
    productId: `product${n}`,
    payload: { id: `product${n}` },
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: now + n,
  }))
  await adminDb.pendingOps.bulkAdd(ops)

  const engine = new AdminSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb })
  engine.stopped = false
  const result = await engine.runSync({ forceNetworkCheck: true })

  // Only the first two ops (createdAt order) were attempted: one genuine
  // failure, then the one that trips the limiter — the loop halts there.
  assert.equal(deleteCalls, 2)
  assert.equal(productsListCalls, 0, 'catalog pull must be skipped while rate limited')

  const stored = await adminDb.pendingOps.toArray()
  const byId = Object.fromEntries(stored.map((op) => [op.id, op]))

  // Genuine (non-429) failure still counts an attempt, same as before.
  assert.equal(byId.op1.status, 'pending')
  assert.equal(byId.op1.attempts, 1)
  assert.match(byId.op1.lastError, /name: Name is required\./)

  // The op that hit the rate limit is not dead-lettered and did not burn an
  // attempt — it only gets pushed past the cooldown window.
  assert.equal(byId.op2.status, 'pending')
  assert.equal(byId.op2.attempts, 0)
  assert.ok(byId.op2.nextAttemptAt > Date.now())

  // Ops the loop never reached are untouched.
  for (const id of ['op3', 'op4', 'op5']) {
    assert.equal(byId[id].status, 'pending')
    assert.equal(byId[id].attempts, 0)
    assert.equal(byId[id].nextAttemptAt, 0)
  }

  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /rate limit/i)
  assert.doesNotMatch(result.warnings[0], /something went wrong/i)

  await adminDb.delete()
  resetPocketBaseRateLimit()
})

test('cashier ops loop halts on 429 and does not dead-letter remaining ops', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  let createCalls = 0
  const fakePb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'activity_logs') {
        return {
          async create() {
            createCalls += 1
            throw rateLimitError()
          },
        }
      }
      // The catalog refresh now runs regardless of unrelated queued ops
      // (see syncEngine's shouldRefreshProducts), so a realistic fake pb
      // must serve it too — this test is about the ops-queue 429 handling,
      // not the catalog.
      if (name === 'products') {
        return { async getFullList() { return [] } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }

  const now = Date.now()
  const ops = [1, 2, 3].map((n) => ({
    id: `op${n}`,
    type: 'activityLog',
    entityId: `entity${n}`,
    payload: { action_type: 'Sale', description: `Sale ${n}`, timestamp: new Date().toISOString() },
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: now + n,
  }))
  await cashierDb.pendingOps.bulkAdd(ops)

  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb })
  engine.stopped = false
  const result = await engine.runSync({ forceNetworkCheck: true })

  assert.equal(createCalls, 1, 'the loop must halt after the first 429, not retry every queued op')

  const stored = await cashierDb.pendingOps.toArray()
  for (const op of stored) {
    assert.equal(op.status, 'pending')
    assert.equal(op.attempts, 0)
  }
  assert.ok(stored.find((op) => op.id === 'op1').nextAttemptAt > Date.now())

  assert.equal(result.failed, 0)
  assert.ok(result.warnings.some((warning) => /rate limit/i.test(warning)))
  assert.ok(!result.warnings.some((warning) => /something went wrong/i.test(warning)))

  await cashierDb.delete()
  resetPocketBaseRateLimit()
})
