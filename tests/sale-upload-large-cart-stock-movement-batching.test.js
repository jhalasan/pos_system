import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// Root-caused from a live incident: a real cashier terminal had several
// large, multi-item sales (36-94 line items -- an ordinary bulk/wholesale
// cart at this store) get permanently stuck retrying every ~60s for DAYS.
// The sale and its sale_items had genuinely, durably synced on the very
// first attempt, but ensureCloudStockDeduction's one-shot "which of these
// lines already have a stock movement?" pre-check OR-chained one filter
// clause per line into a single request -- which PocketBase itself rejects
// past its own filter-length ceiling (400 "max filter length limit
// reached"). That uncaught exception aborted the upload AFTER the sale
// already existed in the cloud, so every retry's sales.create() then failed
// with a transaction_no uniqueness collision instead -- a confusing
// downstream symptom that looked like a totally different bug. Because the
// exception fired before a single stock_movements row was ever created,
// these sales' stock was never deducted in the cloud at all, for as long as
// the bug went unnoticed.
//
// This test uses a cart well past the size that broke in production (40
// lines) and asserts the whole upload completes without throwing, that the
// existing-movement pre-check is issued in small batches (never one giant
// filter), and that every line's stock is actually deducted.

const CASHIER_ID = 'abc123cashier01'

function makeCountingFakePb({ products = [] } = {}) {
  const counts = { stockMovementsGetList: 0, stockMovementsCreate: 0, productsUpdate: 0 }
  const filterLengthsSeen = []
  const productsById = new Map(products.map((p) => [p.id, { ...p }]))
  const movementsByReference = new Map()

  const pb = {
    autoCancellation() {},
    filter: (str, params) => {
      if (!params) return str
      return Object.entries(params).reduce(
        (acc, [key, value]) => acc.replaceAll(`{:${key}}`, `'${value}'`),
        str,
      )
    },
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
            const product = productsById.get(id)
            if (!product) { const err = new Error('not found'); err.status = 404; throw err }
            return product
          },
          async getFullList() { return [...productsById.values()] },
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
          async getFirstListItem() { const err = new Error('not found'); err.status = 404; throw err },
          async getList(page, perPage, { filter }) {
            counts.stockMovementsGetList += 1
            filterLengthsSeen.push(filter.length)
            // Emulate PocketBase's own real-world safeguard: reject any
            // request whose filter string is unreasonably long, exactly the
            // failure mode seen live ("max filter length limit reached").
            if (filter.length > 2000) {
              const err = new Error('Something went wrong while processing your request.')
              err.status = 400
              err.data = { data: {}, message: 'max filter length limit reached' }
              throw err
            }
            const referenceIds = [...filter.matchAll(/reference_id = '([^']+)'/g)].map((m) => m[1])
            const items = referenceIds
              .map((referenceId) => movementsByReference.get(referenceId))
              .filter(Boolean)
            return { items }
          },
          async create(payload) {
            counts.stockMovementsCreate += 1
            const record = { id: `movement-${counts.stockMovementsCreate}`, ...payload }
            movementsByReference.set(payload.reference_id, record)
            return record
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
  return { pb, counts, productsById, filterLengthsSeen }
}

test('a large multi-line cart (40 lines) syncs stock movements without hitting an oversized filter', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const LINE_COUNT = 40
  const products = Array.from({ length: LINE_COUNT }, (_, i) => ({ id: `product-${i}`, quantity: 100 }))
  const { pb, counts, productsById, filterLengthsSeen } = makeCountingFakePb({ products })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const items = products.map((product, i) => ({
    lineId: `line-${i}`,
    productId: product.id,
    name: `Item ${i}`,
    barcode: `${1000 + i}`,
    quantity: 1,
    conversion: 1,
    price: 10,
  }))

  const sale = {
    clientSaleId: 'sale-large-cart-1',
    cashierId: CASHIER_ID,
    transactionNo: 'TXN-LARGE-CART-1',
    totalAmount: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    subtotalAmount: 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date().toISOString(),
    items,
  }

  // Must not throw -- this is exactly the call that aborted forever in
  // production once a cart got large enough.
  await engine.uploadSale(sale)

  assert.ok(counts.stockMovementsGetList > 1, 'the existing-movement pre-check must be split into more than one request for a 40-line sale')
  assert.ok(
    filterLengthsSeen.every((length) => length <= 2000),
    `every pre-check filter must stay within the safe length ceiling, saw: ${filterLengthsSeen.join(', ')}`,
  )
  assert.equal(counts.stockMovementsCreate, LINE_COUNT, 'every line must get its own stock_movements audit row')
  for (const product of products) {
    assert.equal(productsById.get(product.id).quantity, 99, `product ${product.id} must actually be deducted`)
  }

  await cashierDb.delete()
})

test('a large multi-line cart retried after a partial failure does not re-deduct already-recorded lines', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const LINE_COUNT = 40
  const products = Array.from({ length: LINE_COUNT }, (_, i) => ({ id: `product-${i}`, quantity: 100 }))
  const { pb, productsById } = makeCountingFakePb({ products })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const items = products.map((product, i) => ({
    lineId: `line-${i}`,
    productId: product.id,
    name: `Item ${i}`,
    barcode: `${1000 + i}`,
    quantity: 1,
    conversion: 1,
    price: 10,
  }))

  const sale = {
    clientSaleId: 'sale-large-cart-2',
    cashierId: CASHIER_ID,
    transactionNo: 'TXN-LARGE-CART-2',
    totalAmount: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    subtotalAmount: 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: new Date().toISOString(),
    items,
  }

  // First attempt completes fully now that the pre-check is batched.
  await engine.uploadSale(sale)
  // A retry of the same (already-synced) sale must find every movement
  // already recorded and must not double-deduct any product.
  await engine.uploadSale(sale)

  for (const product of products) {
    assert.equal(productsById.get(product.id).quantity, 99, `product ${product.id} must not be deducted twice on retry`)
  }

  await cashierDb.delete()
})
