import Dexie from 'dexie'

export const adminDb = new Dexie('pos_admin')

adminDb.version(1).stores({
  products: '&id, &barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
})

adminDb.version(2).stores({
  products: '&id, &barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
})

adminDb.version(3).stores({
  products: '&id, &barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
  activityLogs: '&id, cloudId, userType, action, time',
})

adminDb.version(4).stores({
  products: '&id, &barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
  activityLogs: '&id, cloudId, userType, action, time',
  authorizationBarcodes: '&id, &barcode, status, createdAt, pendingSync',
})

adminDb.version(5).stores({
  products: '&id, &barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
  activityLogs: '&id, cloudId, userType, action, time',
  authorizationBarcodes: '&id, &barcode, status, createdAt, pendingSync',
  supportTickets: '&id, status, createdAt',
})

// Product barcodes cannot be a unique IndexedDB index because imported
// product groups may reuse or omit a base barcode while their selling-unit
// barcodes remain distinct. Product identity is enforced by id; barcode
// uniqueness is validated by the application when creating/editing records.
adminDb.version(6).stores({
  products: '&id, barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
  activityLogs: '&id, cloudId, userType, action, time',
  authorizationBarcodes: '&id, &barcode, status, createdAt, pendingSync',
  supportTickets: '&id, status, createdAt',
})

adminDb.version(7).stores({
  products: '&id, barcode, name, category, updated, pendingSync',
  categories: '&id, &name',
  pendingOps: '&id, productId, status, createdAt, nextAttemptAt, [status+nextAttemptAt]',
  users: '&id, &email, role, status',
  settings: '&key',
  activityLogs: '&id, cloudId, userType, action, time',
  authorizationBarcodes: '&id, &barcode, status, createdAt, pendingSync',
  supportTickets: '&id, status, createdAt',
  productBarcodeLabels: '&id, &barcode, createdAt, pendingSync',
})

adminDb.on('blocked', () => {
  console.warn('Admin offline database upgrade is blocked by another open window.')
})

// If another window/instance is holding an older connection open, close it
// proactively on versionchange so an upgrade in this window is not left
// hanging indefinitely — otherwise `initializeAdminDb()` never resolves.
adminDb.on('versionchange', () => {
  adminDb.close()
})

const DB_OPEN_TIMEOUT_MS = 10_000

export async function initializeAdminDb() {
  await Promise.race([
    adminDb.open(),
    new Promise((_, reject) => globalThis.setTimeout(
      () => reject(new Error('Admin database is blocked by another open POS window. Close the other window and try again.')),
      DB_OPEN_TIMEOUT_MS,
    )),
  ])
  return adminDb
}
