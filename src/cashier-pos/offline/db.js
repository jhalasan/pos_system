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

cashierDb.on('blocked', () => {
  console.warn('Cashier database upgrade is blocked by another open window.')
})

export async function initializeCashierDb() {
  await cashierDb.open()
  return cashierDb
}
