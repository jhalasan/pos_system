import { adminDb, initializeAdminDb } from '../../admin-page/offline/db.js'
import { initializeCashierDb } from './db.js'
import { getAllProducts, replaceProductsFromCloud } from './productRepository.js'

export async function copyAdminProductCatalogToCashier() {
  await Promise.all([initializeAdminDb(), initializeCashierDb()])
  const adminProducts = await adminDb.products
    .filter((product) => !product.deleted && (product.lifecycleStatus || 'active') === 'active')
    .toArray()

  if (adminProducts.length === 0) return []

  // Reuse the cashier catalog merge so any unsynced sale deductions remain
  // applied while the admin's downloaded catalog is copied across.
  await replaceProductsFromCloud(adminProducts)
  return getAllProducts()
}
