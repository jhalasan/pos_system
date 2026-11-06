import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'
import { resetProductCatalogRefreshThrottle } from '../src/cashier-pos/offline/cloudBootstrap.js'

// Client report: the "Connect Cashier to Cloud" popup came back every few
// minutes even right after signing in, while the cashier's sales were reaching
// the server within seconds. The admin side of the app runs a second copy of
// this engine over the ADMIN's connection; once the admin signs out that copy
// has no login and announced "cloud login required" on every tick. The popup
// signs in the cashier's own connection, so it could never silence it.

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}
const eventBus = new EventTarget()
globalThis.addEventListener = eventBus.addEventListener.bind(eventBus)
globalThis.removeEventListener = eventBus.removeEventListener.bind(eventBus)
globalThis.dispatchEvent = eventBus.dispatchEvent.bind(eventBus)

function captureStatuses() {
  const seen = []
  const listener = (event) => seen.push(event.detail?.state)
  globalThis.addEventListener('nexa-sync-status', listener)
  return { seen, stop: () => globalThis.removeEventListener('nexa-sync-status', listener) }
}

function loggedOutPb({ catalogError } = {}) {
  return {
    autoCancellation() {},
    filter: (text) => text,
    authStore: { isValid: false },
    health: { async check() { return { ok: true } } },
    collection(name) {
      if (name === 'products' && catalogError) return { async getFullList() { throw catalogError } }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
}

async function queueOneSale() {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  resetProductCatalogRefreshThrottle()
  await cashierDb.pendingSales.put({
    clientSaleId: 'queued-1', cashierId: 'abc123cashier01', transactionNo: '2026110600000000001',
    totalAmount: 10, subtotalAmount: 10, paymentMethod: 'cash', createdAt: new Date().toISOString(),
    status: 'pending', nextAttemptAt: 0, items: [{ lineId: 'l1', productId: 'p1', name: 'X', quantity: 1, conversion: 1, price: 10 }],
  })
}

test('the cashier\'s own engine still announces a missing login (so the popup can open)', { concurrency: false }, async () => {
  await queueOneSale()
  const capture = captureStatuses()
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: loggedOutPb() })

  const result = await engine.syncNow({ forceNetworkCheck: true })

  capture.stop()
  assert.ok(capture.seen.includes('auth-required'))
  assert.match(result.warnings[0], /no cloud authorization/i)
  await cashierDb.delete()
})

test('the admin-side copy with no login stays quiet: no auth-required announcement, same result for Sync Center', { concurrency: false }, async () => {
  await queueOneSale()
  const capture = captureStatuses()
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: loggedOutPb(), announceAuthRequired: false })

  const result = await engine.syncNow({ forceNetworkCheck: true })

  capture.stop()
  assert.ok(!capture.seen.includes('auth-required'), 'must not raise the cashier popup')
  assert.match(result.warnings[0], /no cloud authorization/i, 'Sync Center still gets the explanation in the result')
  assert.equal(result.uploaded, 0)
  assert.equal((await cashierDb.pendingSales.count()), 1, 'the queued sale is untouched')
  await cashierDb.delete()
})

test('the quiet copy also stays quiet when the catalog refresh is what fails with 401', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  resetProductCatalogRefreshThrottle()
  const unauthorized = new Error('Something went wrong.')
  unauthorized.status = 401
  const capture = captureStatuses()
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: loggedOutPb({ catalogError: unauthorized }), announceAuthRequired: false })

  const result = await engine.syncNow({ forceNetworkCheck: true })

  capture.stop()
  assert.ok(!capture.seen.includes('auth-required'))
  assert.match(result.warnings[0], /no cloud authorization/i)
  await cashierDb.delete()
})

test('a quiet engine with a valid login still uploads normally', { concurrency: false }, async () => {
  await queueOneSale()
  const created = []
  const pb = {
    autoCancellation() {},
    filter: (text) => text,
    authStore: { isValid: true },
    health: { async check() { return { ok: true } } },
    collection(name) {
      if (name === 'users') return { async getOne() { return { id: 'abc123cashier01' } } }
      if (name === 'sales') return { async create(payload) { created.push(payload); return { id: 'sale000000000001' } } }
      if (name === 'sale_items') return { async getFullList() { return [] }, async create(p) { return { id: 'item00000000001', ...p } } }
      if (name === 'products') {
        return {
          async getFullList() { return [{ id: 'p1', quantity: 5 }] },
          async getOne(id) { return { id, quantity: 5 } },
          async update() { return {} },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFullList() { return [] },
          async getList() { return { items: [] } },
          async getFirstListItem() { const e = new Error('nf'); e.status = 404; throw e },
          async create() { return { id: 'mov00000000001' } },
        }
      }
      if (name === 'activity_logs') {
        return { async getFirstListItem() { const e = new Error('nf'); e.status = 404; throw e }, async create() { return { id: 'log00000000001' } } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb, announceAuthRequired: false })

  engine.stopped = false // syncNow's upload loop only runs for a started engine
  await engine.syncNow({ forceNetworkCheck: true })

  engine.stop() // syncNow re-armed the 60s timer
  assert.equal(created.length, 1, 'the sale was uploaded')
  assert.equal(await cashierDb.pendingSales.get('queued-1'), undefined)
  await cashierDb.delete()
})

test('the logged-out copy refreshing the catalog every 5 minutes (server answers an empty list, not an error) is the popup source -- and stays quiet', { concurrency: false }, async () => {
  // PocketBase answers a logged-out list request with 200 and no rows.
  const emptyListPb = {
    autoCancellation() {},
    filter: (text) => text,
    authStore: { isValid: false },
    health: { async check() { return { ok: true } } },
    collection(name) {
      if (name === 'products') return { async getFullList() { return [] } }
      throw new Error('Unexpected collection: ' + name)
    },
  }
  for (const [announce, expectPopup] of [[true, true], [false, false]]) {
    await cashierDb.delete()
    await initializeCashierDb()
    resetPocketBaseRateLimit()
    resetProductCatalogRefreshThrottle()
    // Local catalog already holds products, as on any working terminal.
    await cashierDb.products.put({ id: 'p1', barcode: '1', name: 'X', category: 'c', updated: '2026-01-01', quantity: 5, price: 1 })
    const capture = captureStatuses()
    const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: emptyListPb, announceAuthRequired: announce })
    await engine.syncNow({ forceNetworkCheck: true })
    capture.stop()
    assert.equal(capture.seen.includes('auth-required'), expectPopup, 'announce=' + announce)
    assert.equal(await cashierDb.products.count(), 1, 'an empty answer from a logged-out request must never wipe the local catalog (announce=' + announce + ')')
  }
  await cashierDb.delete()
})
