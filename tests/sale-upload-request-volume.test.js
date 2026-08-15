import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// T3 (request-volume half): sale upload used to issue ~8-9 PocketBase
// requests per cart line -- a per-line products.getOne to verify the
// relation, a per-line-needing-fallback full catalog re-fetch, a per-line
// findStockMovement lookup, a per-line products.getOne + products.update
// pair, and a per-line reconcileProductStock (2-3 more requests). These
// tests assert the call *counts* directly, which the correctness-focused
// tests elsewhere (sale-line-id-dual-deduction.test.js,
// cashier-sale-retry-corroboration.test.js) don't cover -- a regression here
// could silently reintroduce the old per-line request volume while still
// leaving every value-correctness assertion passing.

const CASHIER_ID = 'abc123cashier01'

function makeCountingFakePb({ products = [] } = {}) {
  const counts = {
    productsGetOne: 0,
    productsGetFullList: 0,
    productsUpdate: 0,
    stockMovementsGetList: 0,
    stockMovementsCreate: 0,
  }
  const productsById = new Map(products.map((p) => [p.id, { ...p }]))

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
          async create(payload) { return { id: `saleitem-${Math.random()}`, ...payload } },
        }
      }
      if (name === 'products') {
        return {
          async getOne(id) {
            counts.productsGetOne += 1
            const product = productsById.get(id)
            if (!product) { const err = new Error('not found'); err.status = 404; throw err }
            return product
          },
          async getFullList() {
            counts.productsGetFullList += 1
            return [...productsById.values()]
          },
          async update(id, patch) {
            counts.productsUpdate += 1
            const product = productsById.get(id)
            if (product) product.quantity = Number(patch.quantity)
            return { id, ...patch }
          },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getList() {
            counts.stockMovementsGetList += 1
            return { items: [] }
          },
          async create(payload) {
            counts.stockMovementsCreate += 1
            return { id: `movement-${counts.stockMovementsCreate}`, ...payload }
          },
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
  return { pb, counts, productsById }
}

function baseSale(items) {
  return {
    clientSaleId: 'sale-volume-1',
    cashierId: CASHIER_ID,
    transactionNo: 'TXN-VOLUME-1',
    totalAmount: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    subtotalAmount: 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date().toISOString(),
    items,
  }
}

test('a cart with two lines of the same product fetches and updates that product exactly once, not once per line', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const { pb, counts } = makeCountingFakePb({ products: [{ id: 'product-1', quantity: 100 }] })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const sale = baseSale([
    { lineId: 'line-a', productId: 'product-1', name: 'Widget (case)', barcode: '1001', quantity: 1, conversion: 24, price: 240 },
    { lineId: 'line-b', productId: 'product-1', name: 'Widget (each)', barcode: '1001-EA', quantity: 2, conversion: 1, price: 50 },
  ])

  await engine.uploadSale(sale)

  assert.equal(counts.productsGetOne, 1, 'one distinct product should be fetched once, not once per line')
  assert.equal(counts.productsUpdate, 1, 'one distinct product should be updated once (deductions summed), not once per line')
  assert.equal(counts.stockMovementsCreate, 2, 'each line still gets its own stock_movements audit row')
  // 1 bulk existing-movement pre-check for the whole sale + 1 reconcileProductStock
  // read for the single distinct product touched -- not one existing-movement
  // check per line, which is the volume win being tested here.
  assert.equal(counts.stockMovementsGetList, 2, 'the existing-movement pre-check must be one bulk query, not one per line')

  await cashierDb.delete()
})

test('a cart with three lines of two distinct products fetches/updates each product exactly once', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const { pb, counts } = makeCountingFakePb({
    products: [{ id: 'product-1', quantity: 100 }, { id: 'product-2', quantity: 50 }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const sale = baseSale([
    { lineId: 'line-a', productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 1, conversion: 1, price: 10 },
    { lineId: 'line-b', productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 1, conversion: 1, price: 10 },
    { lineId: 'line-c', productId: 'product-2', name: 'Gadget', barcode: '2001', quantity: 1, conversion: 1, price: 20 },
  ])

  await engine.uploadSale(sale)

  assert.equal(counts.productsGetOne, 2, 'two distinct products should each be fetched exactly once')
  assert.equal(counts.productsUpdate, 2, 'two distinct products should each be updated exactly once')
  assert.equal(counts.stockMovementsCreate, 3, 'every line still gets its own stock_movements audit row')
  // 1 bulk existing-movement pre-check for the whole sale + 1 reconcileProductStock
  // read per distinct product (2 here) -- still far fewer than one
  // existing-movement check per line.
  assert.equal(counts.stockMovementsGetList, 3, 'the existing-movement pre-check must still be a single bulk query for the whole sale')

  await cashierDb.delete()
})

test('barcode-fallback resolution fetches the full catalog once for the whole sale, not once per line needing it', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const { pb, counts, productsById } = makeCountingFakePb({
    products: [
      { id: 'product-1', quantity: 100, barcode: '1001' },
      { id: 'product-2', quantity: 50, barcode: '2001' },
    ],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  // Neither line carries a productId -- both must be resolved by barcode,
  // the historically-expensive path (used to re-fetch the whole catalog
  // once per such line).
  const sale = baseSale([
    { lineId: 'line-a', productId: '', barcode: '1001', name: 'Widget', quantity: 1, conversion: 1, price: 10 },
    { lineId: 'line-b', productId: '', barcode: '2001', name: 'Gadget', quantity: 1, conversion: 1, price: 20 },
  ])

  await engine.uploadSale(sale)

  // One getFullList call for the (empty) declared-productId bulk-verify
  // step is skipped here since neither line declares a productId; the only
  // getFullList call should be the single shared barcode-fallback catalog
  // fetch.
  assert.equal(counts.productsGetFullList, 1, 'the barcode fallback must fetch the catalog once for the whole sale, not once per line')
  assert.equal(counts.productsUpdate, 2, 'both resolved products should still be deducted correctly')

  // Correctness, not just request volume: a barcode-only line's stock
  // deduction used to be silently skipped entirely, because the deduction
  // step re-read the line's (empty) productId from the raw sale data
  // instead of the productId ensureCloudSaleItems had already resolved by
  // barcode. Both products must show their actual post-sale quantity.
  assert.equal(productsById.get('product-1').quantity, 99, 'the barcode-resolved line must actually be deducted, not silently skipped')
  assert.equal(productsById.get('product-2').quantity, 49, 'the barcode-resolved line must actually be deducted, not silently skipped')

  await cashierDb.delete()
})
