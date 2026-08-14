import Dexie from 'dexie'

export const cashierDb = new Dexie('pos_cashier')

cashierDb.version(1).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt',
  settings: '&key',
})

cashierDb.version(2).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  settings: '&key',
})

cashierDb.version(3).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
  settings: '&key',
})

cashierDb.version(4).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
  quickLoginAccounts: '&id, email, role, status, quickLoginEnabled',
  settings: '&key',
})

cashierDb.version(5).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
  quickLoginAccounts: '&id, email, role, status, quickLoginEnabled',
  pendingOps: '&id, type, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  settings: '&key',
})

cashierDb.version(6).stores({
  products: '&id, &barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
  quickLoginAccounts: '&id, email, role, status, quickLoginEnabled',
  pendingOps: '&id, type, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  receiptCache: '&id, transactionNo, cashierId, createdAt',
  settings: '&key',
})

// Product barcodes cannot be a unique IndexedDB index because imported
// product groups may reuse or omit a base barcode while their selling-unit
// barcodes remain distinct (mirrors src/admin-page/offline/db.js v6). A
// unique index here made a single collision abort the whole bulkPut,
// silently rolling back the entire catalog refresh.
cashierDb.version(7).stores({
  products: '&id, barcode, name, category, updated',
  pendingSales: '&clientSaleId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  completedSales: '&clientSaleId, cashierId, transactionNo, createdAt',
  quickLoginAccounts: '&id, email, role, status, quickLoginEnabled',
  pendingOps: '&id, type, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  receiptCache: '&id, transactionNo, cashierId, createdAt',
  settings: '&key',
})

cashierDb.on('blocked', () => {
  console.warn('Cashier database upgrade is blocked by another open window.')
})

// If another window/instance is holding an older connection open, close it
// proactively on versionchange so an upgrade in this window is not left
// hanging indefinitely — otherwise `initializeCashierDb()` never resolves.
cashierDb.on('versionchange', () => {
  cashierDb.close()
})

const DB_OPEN_TIMEOUT_MS = 10_000

export async function initializeCashierDb() {
  await Promise.race([
    cashierDb.open(),
    new Promise((_, reject) => globalThis.setTimeout(
      () => reject(new Error('Cashier database is blocked by another open POS window. Close the other window and try again.')),
      DB_OPEN_TIMEOUT_MS,
    )),
  ])
  return cashierDb
}
