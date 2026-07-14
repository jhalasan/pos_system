import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { finalizeSaleLocally } from '../src/cashier-pos/offline/saleRepository.js'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

function saleFor(quantity) {
  return {
    cashierId: 'cashier-stock-test',
    cashierName: 'Stock Test',
    transactionNo: `STOCK-${quantity}`,
    totalAmount: 10 * quantity,
    items: [{
      productId: 'product-stock-test',
      name: 'Stock Controlled Product',
      barcode: 'STOCK-TEST',
      quantity,
      conversion: 1,
      price: 10,
    }],
  }
}

test('cashier cannot finalize a sale when cached stock is zero', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({
    id: 'product-stock-test',
    barcode: 'STOCK-TEST',
    name: 'Stock Controlled Product',
    quantity: 0,
    price: 10,
    lifecycleStatus: 'active',
  })

  await assert.rejects(finalizeSaleLocally(saleFor(2)), /has only 0 item\(s\) left/)
  assert.equal(await cashierDb.pendingSales.count(), 0)
  assert.equal((await cashierDb.products.get('product-stock-test')).quantity, 0)
  await cashierDb.delete()
})

test('cashier cannot finalize more units than are locally available', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({
    id: 'product-stock-test',
    barcode: 'STOCK-TEST',
    name: 'Stock Controlled Product',
    quantity: 1,
    price: 10,
    lifecycleStatus: 'active',
  })

  await assert.rejects(finalizeSaleLocally(saleFor(2)), /has only 1 item\(s\) left/)
  assert.equal(await cashierDb.pendingSales.count(), 0)
  assert.equal((await cashierDb.products.get('product-stock-test')).quantity, 1)
  await cashierDb.delete()
})
