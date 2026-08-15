import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// T3: two cart lines of the SAME product (e.g. one sold as a case, one sold
// loose, at different prices) used to collapse into a single
// productId-keyed stock-movement reference in ensureCloudStockDeduction:
// creating the movement for line 1 made findStockMovement report "already
// deducted" for line 2, silently skipping its deduction. Each line now
// carries its own lineId (minted in finalizeSaleLocally), keying its own
// movement reference.

const CASHIER_ID = 'abc123cashier01'

function makeFakePb() {
  let productQuantity = 100
  const movementCreates = []
  const stockMovements = []
  const pb = {
    autoCancellation() {},
    filter: (str) => str,
    collection(name) {
      if (name === 'users') return { async getOne() { return { id: CASHIER_ID } } }
      if (name === 'sales') {
        return { async create(payload) { return { id: 'cloudsale1', ...payload } } }
      }
      if (name === 'sale_items') {
        return {
          async getFullList() { return [] },
          async create(payload) { return { id: `saleitem-${movementCreates.length}`, ...payload } },
        }
      }
      if (name === 'products') {
        return {
          async getOne(id) { return { id, quantity: productQuantity } },
          async update(id, patch) { productQuantity = Number(patch.quantity); return { id, quantity: productQuantity } },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFirstListItem() {
            // Always "not found" -- this test's fake filter() is a
            // passthrough (does not interpolate params), so it can't do a
            // real per-reference lookup here. Existing-movement dedup is
            // covered separately (findStockMovement's own tests); this test
            // is specifically about the two lines not sharing one reference.
            const err = new Error('not found')
            err.status = 404
            throw err
          },
          async create(payload) { movementCreates.push(payload); stockMovements.push(payload); return { id: `mv-${movementCreates.length}` } },
          async getList() { return { items: [] } },
        }
      }
      if (name === 'activity_logs') {
        return {
          async getFirstListItem() { const err = new Error('not found'); err.status = 404; throw err },
          async create() { return { id: 'log1' } },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, movementCreates, getProductQuantity: () => productQuantity }
}

test('two cart lines of the same product each get their own stock deduction', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const { pb, movementCreates, getProductQuantity } = makeFakePb()
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const sale = {
    clientSaleId: 'sale-dual-line',
    cashierId: CASHIER_ID,
    transactionNo: 'TXN-DUAL',
    totalAmount: 340,
    subtotalAmount: 340,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date().toISOString(),
    items: [
      // Same product, two different cart lines: one sold as a case of 24,
      // one sold loose (conversion 1) -- a real scenario (e.g. cashier
      // scanned the case barcode once and the single-unit barcode once).
      { lineId: 'line-a', productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 1, conversion: 24, price: 240 },
      { lineId: 'line-b', productId: 'product-1', name: 'Widget (each)', barcode: '1001-EA', quantity: 2, conversion: 1, price: 50 },
    ],
  }

  await engine.uploadSale(sale)

  // 24 base units for line-a + 2 base units for line-b = 26 total deducted
  // from a starting quantity of 100.
  assert.equal(getProductQuantity(), 74, 'both lines must be deducted -- not just one')
  assert.equal(movementCreates.length, 2, 'each line must produce its own stock_movements record')
  const referenceIds = movementCreates.map((m) => m.reference_id)
  assert.notEqual(referenceIds[0], referenceIds[1], 'the two lines must not share a movement reference')
  assert.ok(referenceIds[0].includes('line-a') || referenceIds[1].includes('line-a'))
  assert.ok(referenceIds[0].includes('line-b') || referenceIds[1].includes('line-b'))

  await cashierDb.delete()
})
