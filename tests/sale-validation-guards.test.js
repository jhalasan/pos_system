import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { finalizeSaleLocally } from '../src/cashier-pos/offline/saleRepository.js'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

// Cashier.jsx's own can('process_sales') check only gated the checkout
// button in the UI -- finalizeSaleLocally (the function that actually
// records a sale) had no equivalent check, so it was callable directly
// (e.g. via devtools) even by an account whose permissions explicitly
// exclude process_sales. This mirrors can()'s own semantics: an
// empty/missing permissions list means unrestricted (this app's
// default-full-access convention), matching every other capability gate.

function saleFor(overrides = {}) {
  return {
    cashierId: 'cashier-guard-test',
    cashierName: 'Guard Test',
    transactionNo: 'GUARD-1',
    totalAmount: 10,
    items: [{
      productId: 'product-guard-test',
      name: 'Guarded Product',
      barcode: 'GUARD-TEST',
      quantity: 1,
      conversion: 1,
      price: 10,
    }],
    ...overrides,
  }
}

async function seedProduct() {
  await cashierDb.products.put({
    id: 'product-guard-test',
    barcode: 'GUARD-TEST',
    name: 'Guarded Product',
    quantity: 5,
    price: 10,
    lifecycleStatus: 'active',
  })
}

test('a cashier explicitly missing the process_sales permission cannot finalize a sale', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await seedProduct()

  await assert.rejects(
    finalizeSaleLocally(saleFor({ cashierPermissions: ['void_transaction'] })),
    /not permitted to process sales/,
  )
  assert.equal(await cashierDb.pendingSales.count(), 0)

  await cashierDb.delete()
})

test('a cashier with process_sales explicitly listed can finalize a sale', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await seedProduct()

  const queued = await finalizeSaleLocally(saleFor({ cashierPermissions: ['process_sales'] }))
  assert.ok(queued.clientSaleId)

  await cashierDb.delete()
})

test('an empty or missing permissions list is unrestricted, matching can()\'s default-full-access convention', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await seedProduct()

  const queuedMissing = await finalizeSaleLocally(saleFor())
  assert.ok(queuedMissing.clientSaleId)

  await cashierDb.products.update('product-guard-test', { quantity: 5 })
  const queuedEmpty = await finalizeSaleLocally(saleFor({ cashierPermissions: [] }))
  assert.ok(queuedEmpty.clientSaleId)

  await cashierDb.delete()
})

// A manager-approved 100% discount is a legitimate, fully-comped sale (e.g.
// senior/PWD + promo stacking, an employee freebie, a documented
// damaged-goods write-off) -- the discount modal already allows approving
// one, but validateSale used to reject any sale whose total wasn't strictly
// greater than zero, so the cashier could go through the entire payment
// flow only to have it fail at the very last step with no way to record it.

test('a fully-discounted (zero total) sale can be finalized', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await seedProduct()

  const queued = await finalizeSaleLocally(saleFor({
    totalAmount: 0,
    discountPercent: 100,
    discountAmount: 10,
    subtotalAmount: 10,
  }))
  assert.ok(queued.clientSaleId)
  assert.equal(queued.totalAmount, 0)

  await cashierDb.delete()
})

test('a negative sale total is still rejected', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await seedProduct()

  await assert.rejects(
    finalizeSaleLocally(saleFor({ totalAmount: -5 })),
    /cannot be negative/,
  )
  assert.equal(await cashierDb.pendingSales.count(), 0)

  await cashierDb.delete()
})
