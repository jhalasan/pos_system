import PocketBase from 'pocketbase'
import { initializeCashierDb } from './db'
import { refreshLocalProductCatalog } from './cloudBootstrap'
import { CashierSyncEngine } from './syncEngine'

let runtimePromise

export function startCashierRuntime({
  baseUrl = import.meta.env.VITE_POCKETBASE_URL,
  onError = console.error,
} = {}) {
  runtimePromise ||= (async () => {
    if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for the cashier runtime.')

    await initializeCashierDb()

    const pb = new PocketBase(baseUrl)
    pb.autoCancellation(false)

    const syncEngine = new CashierSyncEngine({ pb })
    syncEngine.addEventListener('syncerror', (event) => onError(event.detail.error))
    syncEngine.start()

    if (!globalThis.navigator || globalThis.navigator.onLine) {
      refreshLocalProductCatalog({ pb }).catch(onError)
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
