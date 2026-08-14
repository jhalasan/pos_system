import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { replaceProductsFromCloud, getAllProducts } from '../src/cashier-pos/offline/productRepository.js'

test('a cloud catalog with duplicate/blank barcodes still fully lands in the cashier cache', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  const records = [
    { id: 'p1', barcode: '', name: 'No Barcode A', quantity: 5, price: 10 },
    { id: 'p2', barcode: '', name: 'No Barcode B', quantity: 5, price: 10 },
    { id: 'p3', barcode: '123456', name: 'Has Barcode', quantity: 5, price: 10 },
    { id: 'p4', barcode: '123456', name: 'Duplicate Barcode', quantity: 5, price: 10 },
  ]

  await replaceProductsFromCloud(records, null)

  const stored = await getAllProducts()
  assert.equal(stored.length, records.length, 'every record should land even with duplicate/blank barcodes')

  await cashierDb.delete()
})

test('a cloud response with zero products does not wipe an existing good catalog', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await replaceProductsFromCloud([
    { id: 'p1', barcode: '111', name: 'Existing Product', quantity: 5, price: 10 },
  ], null)

  const before = await getAllProducts()
  assert.equal(before.length, 1)

  await assert.rejects(
    () => replaceProductsFromCloud([], null),
    /empty|zero/i,
    'an empty cloud response should be rejected rather than silently clearing a non-empty local catalog',
  )

  const after = await getAllProducts()
  assert.equal(after.length, 1, 'the existing catalog must survive an empty/failed refresh')

  await cashierDb.delete()
})
