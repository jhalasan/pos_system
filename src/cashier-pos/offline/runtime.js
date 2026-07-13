import PocketBase, { LocalAuthStore } from 'pocketbase'
import { cashierDb, initializeCashierDb } from './db'
import { refreshLocalProductCatalog } from './cloudBootstrap'
import { CashierSyncEngine } from './syncEngine'
import {
  isPocketBaseRateLimited,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'

let runtimePromise

async function restoreCashierAuthStore(authStore) {
  if (authStore.isValid && authStore.record?.role === 'cashier') return true
  authStore.clear()

  // Migrate a valid cashier session saved by app versions that used
  // PocketBase's default shared auth key.
  const legacyStore = new LocalAuthStore()
  if (legacyStore.isValid && legacyStore.record?.role === 'cashier') {
    authStore.save(legacyStore.token, legacyStore.record)
    return true
  }

  const credentials = await cashierDb.settings
    .filter((setting) => String(setting.key || '').startsWith('cashierSyncAuth:'))
    .toArray()
  credentials.sort((left, right) => String(right.value?.cachedAt || '').localeCompare(String(left.value?.cachedAt || '')))
  for (const credential of credentials) {
    const token = credential.value?.token
    const user = credential.value?.user
    if (!token || user?.role !== 'cashier') continue
    authStore.save(token, user)
    if (authStore.isValid) return true
  }

  authStore.clear()
  return false
}

export function startCashierRuntime({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  onError = console.error,
} = {}) {
  runtimePromise ||= (async () => {
    if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for the cashier runtime.')

    await initializeCashierDb()

    const authStore = new LocalAuthStore('nexa_cashier_pb_auth')
    await restoreCashierAuthStore(authStore)
    const pb = new PocketBase(baseUrl, authStore)
    pb.autoCancellation(false)

    const syncEngine = new CashierSyncEngine({ pb })
    syncEngine.addEventListener('syncerror', (event) => onError(event.detail.error))
    syncEngine.start()

    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      refreshLocalProductCatalog({ pb }).catch((error) => {
        rememberPocketBaseRateLimit(error)
        onError(error)
      })
    }

    return {
      pb,
      syncEngine,
      login: (email, password) => pb.collection('users').authWithPassword(email, password),
      logout: () => pb.authStore.clear(),
      stop() {
        syncEngine.stop()
      },
      refreshProducts: () => refreshLocalProductCatalog({ pb }),
    }
  })()

  return runtimePromise
}
