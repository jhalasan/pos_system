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

cashierDb.on('blocked', () => {
  console.warn('Cashier database upgrade is blocked by another open window.')
})

export async function initializeCashierDb() {
  await cashierDb.open()
  return cashierDb
}

