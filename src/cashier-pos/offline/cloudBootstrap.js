import PocketBase from 'pocketbase'
import { replaceProductsFromCloud } from './productRepository'
import { rememberPocketBaseRateLimit, withPocketBaseRateLimitLock } from '../../utils/pocketbaseRateLimit'

export async function refreshLocalProductCatalog({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  pb = baseUrl ? new PocketBase(baseUrl) : null,
} = {}) {
  if (!pb) throw new Error('VITE_POCKETBASE_URL is required to refresh the product catalog.')

  return withPocketBaseRateLimitLock(async () => {
    pb.autoCancellation(false)
    const products = await pb.collection('products').getFullList({
      sort: 'name',
      expand: 'category',
      requestKey: null,
    })

    await replaceProductsFromCloud(products, pb)
    return products.length
  }).catch((error) => {
    rememberPocketBaseRateLimit(error)
    throw error
  })
}
