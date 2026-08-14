import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { finalizeSaleLocally } from '../src/cashier-pos/offline/saleRepository.js'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

// A sale line item whose product only exists in the admin cache is recovered
// via loadProductFromAdminCache() and bulkPut into cashierDb.products inside
// the same transaction as the sale itself. That write must never be able to
// abort the sale — regression coverage for the same class of bug fixed in
// replaceProductsFromCloud (a barcode collision must not roll back the
// surrounding transaction).
test('a sale recovers a product from the admin cache even when its barcode collides with an existing row', { concurrency: false }, async () => {
  await Promise.all([cashierDb.delete(), adminDb.delete()])
  await Promise.all([initializeCashierDb(), initializeAdminDb()])

  // An existing cashier-local product sharing a barcode with the one that
  // will be recovered from the admin cache below.
  await cashierDb.products.put({
    id: 'existing-product',
    barcode: 'shared-barcode',
    name: 'Existing Product',
    quantity: 10,
    price: 5,
    lifecycleStatus: 'active',
  })

  await adminDb.products.put({
    id: 'recovered-product',
    barcode: 'shared-barcode',
    name: 'Recovered Product',
    quantity: 10,
    price: 5,
    unit: 'Piece',
    sellingUnits: [],
  })

  const sale = await finalizeSaleLocally({
    cashierId: 'cashier-1',
    cashierName: 'Cashier One',
    totalAmount: 5,
    subtotalAmount: 5,
    items: [
      { productId: 'recovered-product', barcode: 'shared-barcode', name: 'Recovered Product', quantity: 1, price: 5 },
    ],
  })

  assert.equal(sale.status, 'pending')
  const pending = await cashierDb.pendingSales.get(sale.clientSaleId)
  assert.ok(pending, 'the sale must be committed despite the barcode collision on the recovered product')

  await Promise.all([cashierDb.delete(), adminDb.delete()])
})
