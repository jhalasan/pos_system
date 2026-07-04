import PocketBase from 'pocketbase'
import { replaceCategoriesFromCloud, replaceProductsFromCloud } from './productRepository'
import { rememberPocketBaseRateLimit, withPocketBaseRateLimitLock } from '../../utils/pocketbaseRateLimit'

export async function refreshAdminLocalCache({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  pb = baseUrl ? new PocketBase(baseUrl) : null,
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

    await replaceCategoriesFromCloud(categories)
    await replaceProductsFromCloud(products, pb)

    return { categories: categories.length, products: products.length }
  }).catch((error) => {
    rememberPocketBaseRateLimit(error)
    throw error
  })
}
