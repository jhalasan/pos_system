import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { finalizeSaleLocally, voidLocalSale, adjustLocalSale } from '../src/cashier-pos/offline/saleRepository.js'
import {
  rememberPocketBaseRateLimit,
  isPocketBaseRateLimited,
  resetPocketBaseRateLimit,
} from '../src/utils/pocketbaseRateLimit.js'

// STANDING REGRESSION GUARD: no rate-limiting mechanism — today's flat
// cooldown, or the paced governor landing in later tasks of this plan — may
// ever block a cashier's core local-write paths. A terminal must be able to
// finalize a sale, void it, and partially refund it purely against Dexie
// while PocketHost is in an active rate-limit cooldown, with zero network
// calls attempted. This test intentionally stays black-box against the
// public saleRepository functions so it keeps making sense as lineId and
// refund-clamping behavior change in later tasks.

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

function rateLimitError() {
  const err = new Error('Something went wrong.')
  err.status = 429
  return err
}

function saleFor(quantity) {
  return {
    cashierId: 'cashier-rate-limit-test',
    cashierName: 'Rate Limit Test',
    transactionNo: `RATELIMIT-${quantity}`,
    totalAmount: 10 * quantity,
    items: [{
      productId: 'product-rate-limit-test',
      name: 'Rate Limited Product',
      barcode: 'RATE-LIMIT-TEST',
      quantity,
      conversion: 1,
      price: 10,
    }],
  }
}

test('local sale write, void, and partial refund all succeed purely offline while PocketBase is rate limited', { concurrency: false }, async () => {
  resetPocketBaseRateLimit()
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({
    id: 'product-rate-limit-test',
    barcode: 'RATE-LIMIT-TEST',
    name: 'Rate Limited Product',
    quantity: 20,
    price: 10,
    lifecycleStatus: 'active',
  })

  try {
    // Put the module into a hard cooldown, as if a real 429 had just
    // happened on some other request.
    assert.equal(rememberPocketBaseRateLimit(rateLimitError()), true)
    assert.equal(isPocketBaseRateLimited(), true)

    // 1. finalizeSaleLocally: a sale must still commit to pendingSales and
    // decrement stock while rate limited, with no network involved.
    const sale = await finalizeSaleLocally(saleFor(5))
    assert.equal(isPocketBaseRateLimited(), true, 'cooldown must remain untouched by a purely local write')
    assert.equal(await cashierDb.pendingSales.count(), 1)
    const stored = await cashierDb.pendingSales.get(sale.clientSaleId)
    assert.ok(stored, 'the sale must be committed locally')
    assert.equal(stored.status, 'pending')
    assert.equal((await cashierDb.products.get('product-rate-limit-test')).quantity, 15)

    // 2. voidLocalSale: voiding must succeed locally and restore stock. The
    // sale was never uploaded (still purely local, rate-limited), so the
    // pendingSales row is tombstoned (voidPending: true) rather than
    // deleted -- it must stay in the queue for uploadSale to observe and
    // clean up on a later sync tick, otherwise an in-flight upload racing
    // this exact void would have no way to learn about it (see M5).
    const voided = await voidLocalSale(sale.clientSaleId, { voidedBy: 'tester', reason: 'rate limit guard test' })
    assert.equal(isPocketBaseRateLimited(), true, 'cooldown must remain untouched by a purely local void')
    assert.equal(voided.status, 'voided')
    assert.equal(await cashierDb.pendingSales.count(), 1, 'the tombstoned row stays queued for uploadSale to reconcile later')
    const tombstoned = await cashierDb.pendingSales.get(sale.clientSaleId)
    assert.equal(tombstoned.voidPending, true)
    assert.equal((await cashierDb.products.get('product-rate-limit-test')).quantity, 20, 'voiding must restore the full quantity')

    // 3. adjustLocalSale: a partial refund on a second sale must succeed
    // locally and restore stock proportionally to only the returned items.
    const secondSale = await finalizeSaleLocally(saleFor(4))
    assert.equal((await cashierDb.products.get('product-rate-limit-test')).quantity, 16)

    const adjusted = await adjustLocalSale(secondSale.clientSaleId, {
      type: 'refund',
      cashierId: 'cashier-rate-limit-test',
      approvedBy: 'tester',
      reason: 'partial refund under rate limit',
      items: [{ productId: 'product-rate-limit-test', quantity: 2 }],
    })
    assert.equal(isPocketBaseRateLimited(), true, 'cooldown must remain untouched by a purely local refund')
    assert.equal(adjusted.status, 'adjusted')
    assert.equal(adjusted.adjustments.length, 1)
    assert.equal(adjusted.adjustments[0].items[0].quantity, 2)
    assert.equal(
      (await cashierDb.products.get('product-rate-limit-test')).quantity,
      18,
      'only the two returned units must be restored, proportional to the partial refund',
    )
  } finally {
    await cashierDb.delete()
    resetPocketBaseRateLimit()
  }
})
