import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { copyAdminProductCatalogToCashier } from '../src/cashier-pos/offline/catalogCache.js'

test('downloaded admin products remain searchable from the cashier cache offline', { concurrency: false }, async () => {
  await Promise.all([adminDb.delete(), cashierDb.delete()])
  await Promise.all([initializeAdminDb(), initializeCashierDb()])

  await adminDb.products.put({
    id: 'malboro-crafted-ice',
    barcode: '2936693468706',
    name: 'Malboro Crafted Ice',
    category: 'Beverages',
    quantity: 11700,
    price: 8,
    unit: 'Stick',
    sellingUnits: [],
  })
  await adminDb.products.put({
    id: 'archived-product',
    barcode: '2999999999999',
    name: 'Archived Product',
    category: 'Legacy',
    quantity: 5,
    price: 10,
    unit: 'Piece',
    sellingUnits: [],
    lifecycleStatus: 'archived',
  })

  const products = await copyAdminProductCatalogToCashier()

  assert.equal(products.length, 1)
  assert.equal(products[0].name, 'Malboro Crafted Ice')
  assert.equal((await cashierDb.products.get('malboro-crafted-ice')).quantity, 11700)
  assert.equal(await cashierDb.products.get('archived-product'), undefined)

  await Promise.all([adminDb.delete(), cashierDb.delete()])
})
