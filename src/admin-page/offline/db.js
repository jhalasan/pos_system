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

adminDb.on('blocked', () => {
  console.warn('Admin offline database upgrade is blocked by another open window.')
})

export async function initializeAdminDb() {
  await adminDb.open()
  return adminDb
}
