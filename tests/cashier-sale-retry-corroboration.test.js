import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// M4 (second half): findExistingCloudSale used to accept a bare
// transaction_no + cashier_id match as "this is the sale I just retried
// creating," on a sales.create 400/409. Under the old transaction-number
// generator, two genuinely different sales by the same cashier could share
// a transaction_no (10-second wraparound). Adopting the wrong record on
// retry means every subsequent item/stock write in uploadSale runs against
// someone else's sale. A match now also requires the amount and same-day
// timestamp to agree.

const CASHIER_ID = 'abc123cashier01'

function baseSale(overrides = {}) {
  return {
    clientSaleId: 'sale-retry-1',
    cashierId: CASHIER_ID,
    transactionNo: 'TXN-COLLIDE',
    totalAmount: 100,
    subtotalAmount: 100,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date('2026-08-15T10:00:00Z').toISOString(),
    items: [{ productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 1, conversion: 1, price: 100 }],
    ...overrides,
  }
}

function conflictError() {
  const err = new Error('Transaction number already exists.')
  err.status = 409
  return err
}

function makeFakePb({ existingSaleRecord }) {
  const productUpdates = []
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'users') return { async getOne() { return { id: CASHIER_ID } } }
      if (name === 'sales') {
        return {
          async create() { throw conflictError() },
          async getFirstListItem() {
            if (!existingSaleRecord) {
              const err = new Error('not found')
              err.status = 404
              throw err
            }
            return existingSaleRecord
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
          async getFullList() { return [{ id: 'product-1', quantity: 100 }] },
          async update(id, patch) { productUpdates.push({ id, patch }); return {} },
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
  return { pb, productUpdates }
}

test('a retry does not attach to a same transaction_no + cashier_id record with a different amount', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  // Same transaction_no + cashier_id, but a different total_amount and a
  // timestamp days away -- this is a genuinely different sale that happens
  // to share a transaction_no, not a retry of this one.
  const { pb } = makeFakePb({
    existingSaleRecord: {
      id: 'wrongsale000001',
      transaction_no: 'TXN-COLLIDE',
      cashier_id: CASHIER_ID,
      total_amount: 999,
      created_at: '2026-01-01T00:00:00Z',
    },
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await assert.rejects(
    () => engine.uploadSale(baseSale()),
    (error) => error?.status === 409,
    'an uncorroborated match must not be adopted -- the original create error should propagate',
  )

  await cashierDb.delete()
})

test('a retry does attach to a matching record with the same amount and a same-day timestamp', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  await cashierDb.pendingSales.put({ ...baseSale(), status: 'pending' })

  const { pb, productUpdates } = makeFakePb({
    existingSaleRecord: {
      id: 'realsale0000001',
      transaction_no: 'TXN-COLLIDE',
      cashier_id: CASHIER_ID,
      total_amount: 100,
      created_at: '2026-08-15T10:00:05Z',
    },
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(baseSale())

  // Proceeding past findExistingCloudSale means ensureCloudStockDeduction
  // ran against the (correctly) adopted record.
  assert.equal(productUpdates.length, 1)
  assert.equal(await cashierDb.pendingSales.get('sale-retry-1'), undefined)

  await cashierDb.delete()
})
