import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// Reported: the client "can't confirm the void" from Receipt Lookup. The cloud
// side of a void (and of a refund/exchange) located the sale by
// transaction_no AND cashier_id = the cashier who PRESSED Void. When someone
// other than the original cashier voids the receipt (a manager-approved,
// cross-cashier void is a normal workflow here), that lookup finds nothing, the
// queued op fails, and the cloud keeps the sale as "completed" with its stock
// still deducted -- while this terminal already shows it voided. These tests
// use a fake database whose sale lookup really enforces the cashier filter.

const ORIGINAL_CASHIER = 'cashierA0000001'
const VOIDING_CASHIER = 'cashierB0000002'
const PRODUCT_ID = 'product0000001'

function makeFakePb() {
  const state = { saleUpdates: [], productUpdates: [], movementCreates: [], product: { id: PRODUCT_ID, quantity: 7 } }
  const cloudSale = { id: 'cloudsale00001', transaction_no: '20261017001', cashier_id: ORIGINAL_CASHIER, status: 'completed' }
  const pb = {
    autoCancellation() {},
    // Interpolates like the real SDK so the lookup below can read the values.
    filter: (str, params = {}) => Object.entries(params).reduce((acc, [key, value]) => acc.replaceAll(`{:${key}}`, `'${value}'`), str),
    collection(name) {
      if (name === 'sales') {
        return {
          async getFirstListItem(filter) {
            const txn = filter.match(/transaction_no = '([^']*)'/)?.[1]
            const cashier = filter.match(/cashier_id = '([^']*)'/)?.[1]
            const matches = txn === cloudSale.transaction_no && (!cashier || cashier === cloudSale.cashier_id)
            if (matches) return { ...cloudSale }
            const err = new Error('The requested resource wasn\'t found.')
            err.status = 404
            throw err
          },
          async update(id, patch) { state.saleUpdates.push({ id, patch }); return { id, ...patch } },
        }
      }
      if (name === 'products') {
        return {
          async getOne() { return { ...state.product } },
          async update(id, patch) { state.productUpdates.push({ id, patch }); state.product = { ...state.product, ...patch }; return state.product },
          async getFullList() { return [state.product] },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFirstListItem() { const err = new Error('not found'); err.status = 404; throw err },
          async create(payload) { state.movementCreates.push(payload); return { id: `movement${state.movementCreates.length}`, ...payload } },
          async getList() { return { items: [] } },
          async getFullList() { return [] },
        }
      }
      if (name === 'sale_adjustments') {
        return { async getFullList() { return [] }, async create(payload) { return { id: 'adj1', ...payload } } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, state }
}

function voidOp(payloadOverrides = {}) {
  return {
    id: 'op-void-1', type: 'voidCompletedSale', entityId: 'local-sale-1', status: 'pending', attempts: 0, lastError: '', nextAttemptAt: 0, createdAt: Date.now(),
    payload: {
      transactionNo: '20261017001', cashierId: VOIDING_CASHIER, approverId: 'manager000001', reason: 'wrong item',
      items: [{ productId: PRODUCT_ID, quantity: 2, conversion: 1 }], createdAt: new Date().toISOString(),
      ...payloadOverrides,
    },
  }
}

async function runOp(op, { pb }) {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
  await cashierDb.pendingOps.put(op)
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })
  return engine.uploadOperation(op)
}

test('a void by a DIFFERENT cashier than the sale\'s own reaches the cloud: sale voided, stock restored', { concurrency: false }, async () => {
  const fake = makeFakePb()
  await runOp(voidOp({ saleCashierId: ORIGINAL_CASHIER }), fake)

  assert.equal(fake.state.saleUpdates.length, 1, 'the cloud sale must be updated')
  assert.equal(fake.state.saleUpdates[0].patch.status, 'voided')
  assert.equal(fake.state.productUpdates.length, 1, 'stock must be put back')
  assert.equal(Number(fake.state.product.quantity), 9, '7 + 2 returned')
  assert.equal(fake.state.movementCreates[0].movement_type, 'void_return')
  assert.equal(fake.state.movementCreates[0].user_id, VOIDING_CASHIER, 'the movement is attributed to whoever pressed Void')
  assert.equal(await cashierDb.pendingOps.get('op-void-1'), undefined, 'the op leaves the queue')
  await cashierDb.delete()
})

test('a void queued BEFORE this fix (only the voiding cashier recorded) is still delivered, so already-stuck voids recover', { concurrency: false }, async () => {
  const fake = makeFakePb()
  await runOp(voidOp(), fake) // cashierId = voider, no saleCashierId -- exactly what old terminals queued

  assert.equal(fake.state.saleUpdates[0]?.patch.status, 'voided')
  assert.equal(Number(fake.state.product.quantity), 9)
  assert.equal(await cashierDb.pendingOps.get('op-void-1'), undefined)
  await cashierDb.delete()
})

test('a same-cashier void behaves exactly as before', { concurrency: false }, async () => {
  const fake = makeFakePb()
  await runOp(voidOp({ cashierId: ORIGINAL_CASHIER, saleCashierId: ORIGINAL_CASHIER }), fake)

  assert.equal(fake.state.saleUpdates[0]?.patch.status, 'voided')
  assert.equal(Number(fake.state.product.quantity), 9)
  await cashierDb.delete()
})

test('a refund by a different cashier is delivered too (same lookup)', { concurrency: false }, async () => {
  const fake = makeFakePb()
  const op = voidOp({ type: 'adjustCompletedSale', saleCashierId: ORIGINAL_CASHIER, type_: undefined })
  op.type = 'adjustCompletedSale'
  op.id = 'op-adjust-1'
  op.payload = { ...op.payload, type: 'refund', adjustmentId: '', restock: true, items: [{ productId: PRODUCT_ID, quantity: 1, conversion: 1 }] }
  await runOp(op, fake)

  assert.equal(fake.state.saleUpdates.at(-1)?.patch.status, 'adjusted')
  assert.equal(Number(fake.state.product.quantity), 8, '7 + 1 refunded and restocked')
  await cashierDb.delete()
})

test('a sale that genuinely does not exist still fails (the fallback does not hide real errors)', { concurrency: false }, async () => {
  const fake = makeFakePb()
  await assert.rejects(() => runOp(voidOp({ transactionNo: 'does-not-exist', saleCashierId: ORIGINAL_CASHIER }), fake), (error) => error?.status === 404)
  assert.equal(fake.state.saleUpdates.length, 0)
  assert.equal(fake.state.productUpdates.length, 0, 'no stock moves for a sale that was never found')
  await cashierDb.delete()
})
