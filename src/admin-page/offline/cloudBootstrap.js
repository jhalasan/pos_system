import PocketBase from 'pocketbase'
import { replaceCategoriesFromCloud, replaceProductsFromCloud } from './productRepository'
import { rememberPocketBaseRateLimit, withPocketBaseRateLimitLock } from '../../utils/pocketbaseRateLimit'

export async function refreshAdminLocalCache({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  pb = baseUrl ? new PocketBase(baseUrl) : null,
  requireCatalog = false,
} = {}) {
  if (!pb) throw new Error('VITE_POCKETBASE_URL is required to refresh the admin cache.')

  return withPocketBaseRateLimitLock(async () => {
    pb.autoCancellation(false)
    const [categories, products] = await Promise.all([
      pb.collection('categories').getFullList({ sort: 'name', requestKey: null }),
      pb.collection('products').getFullList({
        sort: 'name',
        expand: 'category',
        requestKey: null,
      }),
    ])

    if (requireCatalog && products.length === 0) {
      throw new Error('The cloud returned zero products. Confirm this terminal is online, signed in with an active admin account, and connected to the correct PocketBase database.')
    }

    await replaceCategoriesFromCloud(categories)
    await replaceProductsFromCloud(products, pb)

    return { categories: categories.length, products: products.length }
  }).catch((error) => {
    rememberPocketBaseRateLimit(error)
    throw error
  })
}
