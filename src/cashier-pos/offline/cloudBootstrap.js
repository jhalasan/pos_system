import PocketBase from 'pocketbase'
import { replaceProductsFromCloud } from './productRepository'
import { rememberPocketBaseRateLimit, withPocketBaseRateLimitLock } from '../../utils/pocketbaseRateLimit'

// Scanning a cached item triggers a "keep it fresh" background catalog pull.
// Without a floor between pulls, ringing up a multi-item sale fires one full
// products.getFullList() per scan, which is what was blowing through
// PocketHost's request-rate limit and locking cashiers out of scanning/login.
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 3 * 60_000
let lastRefreshCompletedAt = 0

export async function refreshLocalProductCatalog({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  pb = baseUrl ? new PocketBase(baseUrl) : null,
  background = false,
} = {}) {
  if (!pb) throw new Error('VITE_POCKETBASE_URL is required to refresh the product catalog.')

  if (background && Date.now() - lastRefreshCompletedAt < BACKGROUND_REFRESH_MIN_INTERVAL_MS) {
    return 0
  }

  return withPocketBaseRateLimitLock(async () => {
    pb.autoCancellation(false)
    const products = await pb.collection('products').getFullList({
      sort: 'name',
      expand: 'category',
      requestKey: null,
    })

    await replaceProductsFromCloud(products, pb)
    lastRefreshCompletedAt = Date.now()
    return products.length
  }).catch((error) => {
    rememberPocketBaseRateLimit(error)
    throw error
  })
}

/** Test-only: clears the module-level throttle so suites don't leak state into each other. */
export function resetProductCatalogRefreshThrottle() {
  lastRefreshCompletedAt = 0
}
