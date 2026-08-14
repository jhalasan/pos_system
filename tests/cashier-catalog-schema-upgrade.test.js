import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import Dexie from 'dexie'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'

// Simulates a terminal already deployed with the old (pre-fix) schema, where
// `products.barcode` was a unique index. The v7 upgrade must open on top of
// that data without an .upgrade() callback or any row loss — Dexie
// re-indexes existing rows automatically when only a secondary index's
// uniqueness changes (confirmed by tracing Dexie's getSchemaDiff/deleteIndex
// path; `recreate: true` is only set for primary-key changes).
test('rows written under the old unique-barcode schema survive the v7 upgrade', { concurrency: false }, async () => {
  await cashierDb.delete()

  const legacyDb = new Dexie('pos_cashier')
  legacyDb.version(6).stores({
    products: '&id, &barcode, name, category, updated',
    pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
    completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
    quickLoginAccounts: '&id, email, role, status, quickLoginEnabled',
    pendingOps: '&id, type, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
    receiptCache: '&id, transactionNo, cashierId, createdAt',
    settings: '&key',
  })
  await legacyDb.open()
  await legacyDb.products.bulkPut([
    { id: 'p1', barcode: '111', name: 'Legacy Product A', quantity: 5, price: 10 },
    { id: 'p2', barcode: '222', name: 'Legacy Product B', quantity: 3, price: 20 },
  ])
  legacyDb.close()

  await initializeCashierDb()

  const rows = await cashierDb.products.toArray()
  assert.equal(rows.length, 2, 'existing rows must survive the upgrade to v7')
  assert.deepEqual(rows.map((r) => r.id).sort(), ['p1', 'p2'])

  // The new non-unique index must accept duplicate/blank barcodes going forward.
  await cashierDb.products.bulkPut([
    { id: 'p3', barcode: '', name: 'New blank-barcode product', quantity: 1, price: 1 },
    { id: 'p4', barcode: '', name: 'Another blank-barcode product', quantity: 1, price: 1 },
  ])
  const blanks = await cashierDb.products.where('barcode').equals('').toArray()
  assert.equal(blanks.length, 2)

  await cashierDb.delete()
})
