import PocketBase from 'pocketbase'
import { replaceCategoriesFromCloud, replaceProductsFromCloud } from './productRepository'
import { rememberPocketBaseRateLimit, withPocketBaseRateLimitLock } from '../../utils/pocketbaseRateLimit'
import { createPacedPocketBase } from '../../utils/pacedPocketBase'
import { sharedGovernor } from '../../utils/pocketbaseGovernorInstance'

export async function refreshAdminLocalCache({
  // Optional chaining matters here: under Vite this is always populated by
  // `define`, but a caller (e.g. the sync engine) that passes only `pb` and
  // no `baseUrl` still evaluates this default -- under a plain Node runtime
  // (tests) `import.meta.env` itself is undefined, not just the var. Mirrors
  // the identical fix already applied to the cashier equivalent in
  // cashier-pos/offline/cloudBootstrap.js.
  baseUrl = import.meta.env?.VITE_POCKETBASE_URL,
  pb = baseUrl ? createPacedPocketBase(new PocketBase(baseUrl), sharedGovernor) : null,
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
