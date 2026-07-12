import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminDb, initializeAdminDb } from '../src/admin-page/offline/db.js'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'

test('admin mutations survive a database close and reopen', { concurrency: false }, async () => {
  await adminDb.delete()
  await initializeAdminDb()
  await adminDb.pendingOps.put({
    id: 'admin-restart-op',
    type: 'createCategory',
    productId: 'category_local',
    payload: { name: 'Offline Category' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  })
  adminDb.close()

  await initializeAdminDb()
  assert.equal((await adminDb.pendingOps.get('admin-restart-op')).payload.name, 'Offline Category')
  await adminDb.delete()
})

test('cashier sales and register operations survive a database close and reopen', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.pendingSales.put({
    clientSaleId: 'sale-restart-1',
    cashierId: 'cashier-1',
    transactionNo: 'TX-RESTART',
    items: [],
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  })
  await cashierDb.pendingOps.put({
    id: 'register-restart-op',
    type: 'closeCashRegisterSession',
    payload: { sessionId: 'shift_local' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  })
  cashierDb.close()

  await initializeCashierDb()
  assert.ok(await cashierDb.pendingSales.get('sale-restart-1'))
  assert.ok(await cashierDb.pendingOps.get('register-restart-op'))
  await cashierDb.delete()
})
