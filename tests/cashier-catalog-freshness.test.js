import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { replaceProductsFromCloud, isCatalogIncomplete } from '../src/cashier-pos/offline/productRepository.js'

test('a catalog with no sync stamp is treated as incomplete', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.products.put({ id: 'p1', barcode: '1', name: 'Product', quantity: 1, price: 1, lifecycleStatus: 'active' })

  assert.equal(await isCatalogIncomplete(), true, 'a terminal upgraded from a build with no sync stamp must self-heal once')

  await cashierDb.delete()
})

test('a catalog whose stored count no longer matches the last successful refresh is incomplete', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await replaceProductsFromCloud([
    { id: 'p1', barcode: '1', name: 'A', quantity: 1, price: 1 },
    { id: 'p2', barcode: '2', name: 'B', quantity: 1, price: 1 },
  ], null)

  assert.equal(await isCatalogIncomplete(), false, 'a freshly synced catalog is complete')

  // Simulate rows disappearing out from under the stamp (e.g. a partial write elsewhere).
  await cashierDb.products.delete('p2')

  assert.equal(await isCatalogIncomplete(), true, 'a stored count that no longer matches the stamp must be treated as incomplete')

  await cashierDb.delete()
})

test('a stale stamp past maxAgeMs is treated as incomplete', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await replaceProductsFromCloud([
    { id: 'p1', barcode: '1', name: 'A', quantity: 1, price: 1 },
  ], null)

  assert.equal(await isCatalogIncomplete({ maxAgeMs: 60_000 }), false)

  const setting = await cashierDb.settings.get('productCatalogSync')
  setting.value.completedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  await cashierDb.settings.put(setting)

  assert.equal(await isCatalogIncomplete({ maxAgeMs: 60_000 }), true, 'a stamp older than maxAgeMs must trigger a refresh')

  await cashierDb.delete()
})
