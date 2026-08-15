import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// M5: a void issued while a sale's own upload was in flight used to be lost
// cloud-side. voidLocalSale tombstones the pendingSales row (voidPending:
// true) instead of deleting it; uploadSale must react to that tombstone
// both on entry (voided before this tick ever tried to upload it) and right
// before its final write (voided by a concurrent call while this exact
// upload was in progress).

const CASHIER_ID = 'abc123cashier01' // must look like a 15-char PB record id

function baseSale(clientSaleId) {
  return {
    clientSaleId,
    cashierId: CASHIER_ID,
    transactionNo: `TXN-${clientSaleId}`,
    totalAmount: 100,
    subtotalAmount: 100,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date().toISOString(),
    items: [{ productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 2, conversion: 1, price: 50 }],
  }
}

function makeFakePb({ onSalesCreate } = {}) {
  let salesCreateCalls = 0
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'users') {
        return { async getOne() { return { id: CASHIER_ID } } }
      }
      if (name === 'sales') {
        return {
          async create(payload) {
            salesCreateCalls += 1
            if (onSalesCreate) await onSalesCreate()
            return { id: 'cloudsale00001', ...payload }
          },
          async getFirstListItem() {
            const err = new Error('not found')
            err.status = 404
            throw err
          },
        }
      }
      if (name === 'sale_items') {
        return {
          async getFullList() { return [] },
          async create(payload) { return { id: 'saleitem0000001', ...payload } },
        }
      }
      if (name === 'products') {
        return {
          async getOne(id) { return { id, quantity: 100 } },
          async update() { return {} },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFirstListItem() {
            const err = new Error('not found')
            err.status = 404
            throw err
          },
          async create() { return { id: 'movement0000001' } },
          async getList() { return { items: [] } },
        }
      }
      if (name === 'activity_logs') {
        return {
          async getFirstListItem() {
            const err = new Error('not found')
            err.status = 404
            throw err
          },
          async create() { return { id: 'log0000000000001' } },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, salesCreateCallCount: () => salesCreateCalls }
}

test('uploadSale skips the cloud entirely for a sale already tombstoned before this tick', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const { pb, salesCreateCallCount } = makeFakePb()
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const sale = baseSale('sale-never-synced')
  await cashierDb.pendingSales.put({ ...sale, status: 'pending', voidPending: true, voidReason: 'changed mind', voidedAt: new Date().toISOString() })
  await cashierDb.completedSales.put({ ...sale, status: 'voided', syncStatus: 'voided' })

  await engine.uploadSale({ ...sale, voidPending: true })

  assert.equal(salesCreateCallCount(), 0, 'nothing reached the cloud was ever attempted -- there is nothing to undo there')
  assert.equal(await cashierDb.pendingSales.get('sale-never-synced'), undefined, 'the tombstoned row is cleaned up locally')
  const completed = await cashierDb.completedSales.get('sale-never-synced')
  assert.equal(completed.syncStatus, 'voided')
  const queuedOps = await cashierDb.pendingOps.toArray()
  assert.equal(queuedOps.length, 0, 'nothing was ever created in the cloud, so no void op is needed')

  await cashierDb.delete()
})

test('uploadSale queues a cloud void when tombstoned mid-flight, instead of marking the sale synced', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const sale = baseSale('sale-race')
  await cashierDb.pendingSales.put({ ...sale, status: 'pending' })
  await cashierDb.completedSales.put({ ...sale, status: 'completed', syncStatus: 'pending' })

  // Simulate voidLocalSale racing in between this upload's sales.create and
  // its final write: the exact scenario M5 fixes.
  const { pb, salesCreateCallCount } = makeFakePb({
    onSalesCreate: async () => {
      await cashierDb.pendingSales.update('sale-race', {
        voidPending: true,
        voidReason: 'customer cancelled mid-checkout',
        voidedBy: 'manager-1',
        voidedAt: new Date().toISOString(),
      })
    },
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(salesCreateCallCount(), 1, 'the upload did reach sales.create -- the cloud sale now exists')
  assert.equal(await cashierDb.pendingSales.get('sale-race'), undefined, 'the queue row is cleaned up once handed off to the void op')

  const completed = await cashierDb.completedSales.get('sale-race')
  assert.equal(completed.syncStatus, 'voided', 'must never be marked plain "synced" -- that would mean the cloud copy is treated as a normal completed sale forever')

  const queuedOps = await cashierDb.pendingOps.where('type').equals('voidCompletedSale').toArray()
  assert.equal(queuedOps.length, 1, 'a cloud void op must be queued to undo the sale this exact upload just created')
  assert.equal(queuedOps[0].entityId, 'sale-race')
  assert.equal(queuedOps[0].payload.transactionNo, sale.transactionNo)
  assert.equal(queuedOps[0].payload.reason, 'customer cancelled mid-checkout')

  await cashierDb.delete()
})
