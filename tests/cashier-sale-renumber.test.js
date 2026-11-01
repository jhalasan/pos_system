import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import {
  claimReplacementTransactionNumber,
  mintTransactionNumber,
  REPLACEMENT_COUNTER_START,
} from '../src/cashier-pos/offline/transactionNumber.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// 2026-10-30: a terminal's receipt counter restarted at 1 after a power cut, so
// its new sales reused numbers the cloud already held. PocketBase refused each
// one ("Value must be unique") and they retried forever -- about 90 sales, and
// the stock they should have taken, stuck on one computer. These tests cover
// the rescue: a number that is taken by a DIFFERENT sale is replaced, nothing
// is ever filed under someone else's receipt, and goods a later Stock Count
// already covers are not deducted twice.

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

const CASHIER_ID = 'abc123cashier01'
const SALE_TIME = '2026-10-30T04:00:00.000Z'

function uniqueError() {
  const err = new Error('Failed to create record.')
  err.status = 400
  err.response = { data: { transaction_no: { code: 'validation_not_unique', message: 'Value must be unique' } } }
  return err
}

function notFound() {
  const err = new Error('not found')
  err.status = 404
  return err
}

function queuedSale(overrides = {}) {
  return {
    clientSaleId: 'stuck-sale-1',
    cashierId: CASHIER_ID,
    transactionNo: '2026103005073100001',
    totalAmount: 100,
    subtotalAmount: 100,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: 'cash',
    createdAt: SALE_TIME,
    status: 'pending',
    items: [{ lineId: 'line-mine-1', productId: 'product-1', name: 'Widget', barcode: '1001', quantity: 2, conversion: 1, price: 50 }],
    ...overrides,
  }
}

// A small in-memory PocketBase: just enough behaviour to see what lands where.
function makeFakePb({ sales = [], saleItems = [], movements = [], failCreateWith } = {}) {
  const state = { sales: [...sales], saleItems: [...saleItems], movements: [...movements], logs: [], productUpdates: [], nextId: 1 }
  const id = () => `rec${String(state.nextId++).padStart(12, '0')}`
  const pb = {
    autoCancellation() {},
    // Filters are only ever used by this fake, so record their params instead.
    filter: (text, params) => JSON.stringify({ text, params }),
    collection(name) {
      const parse = (filter) => JSON.parse(filter).params
      if (name === 'users') return { async getOne() { return { id: CASHIER_ID } } }
      if (name === 'sales') {
        return {
          async create(payload) {
            if (failCreateWith) throw failCreateWith
            if (state.sales.some((sale) => sale.transaction_no === payload.transaction_no)) throw uniqueError()
            const record = { id: id(), ...payload }
            state.sales.push(record)
            return record
          },
          async getFirstListItem(filter) {
            const params = parse(filter)
            const found = state.sales.find((sale) => sale.transaction_no === params.transactionNo
              && (!params.cashierId || sale.cashier_id === params.cashierId))
            if (!found) throw notFound()
            return found
          },
        }
      }
      if (name === 'sale_items') {
        return {
          async getFullList({ filter }) {
            const { saleId } = parse(filter)
            return state.saleItems.filter((item) => item.sale_id === saleId)
          },
          async create(payload) {
            const record = { id: id(), ...payload }
            state.saleItems.push(record)
            return record
          },
        }
      }
      if (name === 'products') {
        return {
          async getOne(productId) { return { id: productId, quantity: 100 } },
          async getFullList() { return [{ id: 'product-1', quantity: 100 }] },
          async update(productId, patch) { state.productUpdates.push({ id: productId, patch }); return {} },
        }
      }
      if (name === 'stock_movements') {
        return {
          async getFirstListItem(filter) {
            const params = parse(filter)
            // "a Stock Count taken since the sale"
            if (params.since !== undefined) {
              const since = new Date(String(params.since).replace(' ', 'T')).getTime()
              const found = state.movements.find((m) => m.product_id === params.productId
                && m.movement_type === 'adjustment' && new Date(m.created).getTime() > since)
              if (!found) throw notFound()
              return found
            }
            throw notFound()
          },
          async create(payload) {
            const record = { id: id(), created: new Date().toISOString(), ...payload }
            state.movements.push(record)
            return record
          },
          async getList() { return { items: [] } },
          async getFullList() { return [] },
        }
      }
      if (name === 'activity_logs') {
        return {
          async getFirstListItem(filter) {
            const params = parse(filter)
            const found = state.logs.find((log) => log.description === params.description)
            if (!found) throw notFound()
            return found
          },
          async create(payload) { state.logs.push(payload); return { id: id() } },
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
  }
  return { pb, state }
}

async function freshDb() {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()
}

async function enqueue(sale) {
  await cashierDb.pendingSales.put(sale)
  await cashierDb.completedSales.put({ ...sale, status: 'completed', syncStatus: 'pending' })
}

const foreignSale = (overrides = {}) => ({
  id: 'foreignsale0001',
  transaction_no: '2026103005073100001',
  cashier_id: CASHIER_ID,
  total_amount: 999,
  created_at: '2026-10-30T00:30:00.000Z',
  ...overrides,
})

test('a receipt number taken by a DIFFERENT sale is replaced, and the sale uploads under the new number', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  // A queued void/refund for this sale, plus one for an unrelated sale that
  // happens to name the same old receipt number.
  await cashierDb.pendingOps.bulkPut([
    { id: 'op-mine', type: 'adjustCompletedSale', entityId: 'stuck-sale-1', payload: { transactionNo: sale.transactionNo }, status: 'pending' },
    { id: 'op-other', type: 'adjustCompletedSale', entityId: 'someone-else', payload: { transactionNo: sale.transactionNo }, status: 'pending' },
  ])
  const { pb, state } = makeFakePb({ sales: [foreignSale()] })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  const uploaded = state.sales.find((record) => record.total_amount === 100)
  assert.ok(uploaded, 'the stuck sale reached the cloud')
  assert.notEqual(uploaded.transaction_no, sale.transactionNo)
  assert.match(uploaded.transaction_no, /^20261030\d{11}$/, 'still 19 digits, on the sale\'s own day')
  const ordinaryNumber = await mintTransactionNumber(new Date(SALE_TIME))
  assert.equal(uploaded.transaction_no.slice(0, 14), ordinaryNumber.slice(0, 14), 'same terminal prefix as ordinary numbers')
  assert.ok(Number(uploaded.transaction_no.slice(14)) > REPLACEMENT_COUNTER_START, 'taken from the replacement range')
  assert.equal(state.sales.find((record) => record.id === 'foreignsale0001').total_amount, 999, 'the other sale is untouched')
  assert.equal(state.saleItems.filter((item) => item.sale_id === 'foreignsale0001').length, 0, 'nothing was filed under the other receipt')
  assert.equal(state.saleItems.filter((item) => item.sale_id === uploaded.id).length, 1)
  assert.equal(state.productUpdates.length, 1, 'stock is deducted once')

  assert.equal(await cashierDb.pendingSales.get('stuck-sale-1'), undefined, 'the queue entry is cleared')
  const completed = await cashierDb.completedSales.get('stuck-sale-1')
  assert.equal(completed.transactionNo, uploaded.transaction_no, 'the local receipt history shows the number the cloud has')
  assert.equal(completed.originalTransactionNo, sale.transactionNo, 'and remembers the number on the paper receipt')
  assert.equal(completed.syncStatus, 'synced')
  assert.equal((await cashierDb.pendingOps.get('op-mine')).payload.transactionNo, uploaded.transaction_no, 'its queued void/refund follows the new number')
  assert.equal((await cashierDb.pendingOps.get('op-other')).payload.transactionNo, sale.transactionNo, 'an unrelated queued operation is left alone')
  assert.equal(state.logs.filter((log) => log.action_type === 'Receipt Renumbered').length, 1, 'the change is written to the activity log')
  await cashierDb.delete()
})

test('same cashier, amount and day but ANOTHER sale\'s lines: not adopted, so it is renumbered instead of merged', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const lookalike = foreignSale({ total_amount: 100, created_at: '2026-10-30T01:00:00.000Z' })
  const { pb, state } = makeFakePb({
    sales: [lookalike],
    saleItems: [{ id: 'theiritem00001', sale_id: lookalike.id, line_id: 'line-theirs-9', product_id: 'product-9' }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(state.saleItems.filter((item) => item.sale_id === lookalike.id).length, 1, 'their receipt still has only their line')
  const uploaded = state.sales.find((record) => record.id !== lookalike.id)
  assert.ok(uploaded, 'this sale got its own record')
  assert.deepEqual(state.saleItems.filter((item) => item.sale_id === uploaded.id).map((item) => item.line_id), ['line-mine-1'])
  await cashierDb.delete()
})

test('a retry of the SAME sale (its own lines are already there) is still adopted, never duplicated', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const earlier = foreignSale({ id: 'mineearlier0001', total_amount: 100, created_at: SALE_TIME })
  const { pb, state } = makeFakePb({
    sales: [earlier],
    saleItems: [{ id: 'myitem00000001', sale_id: earlier.id, line_id: 'line-mine-1', product_id: 'product-1' }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(state.sales.length, 1, 'no second cloud sale')
  assert.equal(state.sales[0].transaction_no, sale.transactionNo, 'the number was not changed')
  assert.equal((await cashierDb.completedSales.get('stuck-sale-1')).originalTransactionNo, undefined)
  assert.equal(state.logs.filter((log) => log.action_type === 'Receipt Renumbered').length, 0)
  await cashierDb.delete()
})

test('a Stock Count taken after the sale already covers its goods: they are not deducted again', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const { pb, state } = makeFakePb({
    sales: [foreignSale()],
    movements: [{ id: 'count00000001', product_id: 'product-1', movement_type: 'adjustment', created: '2026-10-31 04:20:34.573Z' }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(state.sales.filter((record) => record.total_amount === 100).length, 1, 'the sale itself is still recorded')
  assert.equal(state.productUpdates.length, 0, 'product quantity untouched')
  assert.equal(state.movements.filter((m) => m.movement_type === 'sale').length, 0, 'no sale movement for the counted goods')
  const log = state.logs.find((entry) => entry.action_type === 'Receipt Renumbered')
  assert.match(log.description, /Stock not deducted again.*Widget/)
  await cashierDb.delete()
})

test('a Stock Count taken BEFORE the sale does not hide it: the goods are deducted', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const { pb, state } = makeFakePb({
    sales: [foreignSale()],
    movements: [{ id: 'count00000002', product_id: 'product-1', movement_type: 'adjustment', created: '2026-10-29 04:20:34.573Z' }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(state.productUpdates.length, 1)
  assert.equal(state.movements.filter((m) => m.movement_type === 'sale').length, 1)
  await cashierDb.delete()
})

test('an ordinary sale (never renumbered) still ignores the Stock Count check', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale({ transactionNo: '2026103005073100777' })
  await enqueue(sale)
  const { pb, state } = makeFakePb({
    movements: [{ id: 'count00000003', product_id: 'product-1', movement_type: 'adjustment', created: '2026-10-31 04:20:34.573Z' }],
  })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  assert.equal(state.productUpdates.length, 1, 'normal uploads behave exactly as before')
  await cashierDb.delete()
})

test('a 400 that is not "number already used" is still reported, never renumbered', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const bad = new Error('Failed to create record.')
  bad.status = 400
  bad.response = { data: { total_amount: { code: 'validation_required' } } }
  const { pb, state } = makeFakePb({ failCreateWith: bad })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await assert.rejects(() => engine.uploadSale(sale), (error) => error === bad)
  assert.equal((await cashierDb.pendingSales.get('stuck-sale-1')).transactionNo, sale.transactionNo)
  assert.equal(state.sales.length, 0)
  await cashierDb.delete()
})

test('replacement numbers skip any that the cloud or this terminal already uses', { concurrency: false }, async () => {
  await freshDb()
  const sale = queuedSale()
  await enqueue(sale)
  const first = await claimReplacementTransactionNumber(SALE_TIME)
  const second = await claimReplacementTransactionNumber(SALE_TIME)
  // Reset so the engine's own claim starts from the same place, then occupy
  // the next number in the cloud and a later one locally.
  await cashierDb.settings.clear()
  const third = await claimReplacementTransactionNumber(SALE_TIME)
  assert.equal(third, first, 'sanity: the counter restarted')
  await cashierDb.settings.clear()
  const cloudTaken = foreignSale({ id: 'cloudtaken00001', transaction_no: first, total_amount: 5 })
  const { pb, state } = makeFakePb({ sales: [foreignSale(), cloudTaken] })
  await cashierDb.completedSales.put({ ...queuedSale({ clientSaleId: 'other-local', transactionNo: second }), status: 'completed' })
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  await engine.uploadSale(sale)

  const uploaded = state.sales.find((record) => record.total_amount === 100)
  assert.notEqual(uploaded.transaction_no, first, 'skipped the one the cloud holds')
  assert.notEqual(uploaded.transaction_no, second, 'skipped the one a local receipt holds')
  await cashierDb.delete()
})

test('replacement numbers never feed the ordinary counter', { concurrency: false }, async () => {
  await freshDb()
  const now = new Date(2026, 9, 30, 12, 0, 0)
  const first = await mintTransactionNumber(now)
  const replacement = await claimReplacementTransactionNumber(now)
  assert.ok(Number(replacement.slice(14)) > REPLACEMENT_COUNTER_START)
  await cashierDb.completedSales.put({ clientSaleId: 'r', transactionNo: replacement, createdAt: now.toISOString() })
  const next = await mintTransactionNumber(now)
  assert.equal(next.slice(14), '00002', 'the next ordinary number is simply the next one')
  assert.equal(first.slice(14), '00001')
  await cashierDb.delete()
})

test('if the saved counter is lost but the day\'s sales survive, numbers carry on instead of restarting', { concurrency: false }, async () => {
  await freshDb()
  const now = new Date(2026, 9, 30, 11, 18, 0)
  const numbers = []
  for (let i = 0; i < 5; i += 1) {
    const number = await mintTransactionNumber(now)
    numbers.push(number)
    await cashierDb.completedSales.put({ clientSaleId: `s${i}`, transactionNo: number, createdAt: now.toISOString() })
  }
  assert.equal(numbers[4].slice(14), '00005')

  await cashierDb.settings.clear() // the power cut
  const afterLoss = await mintTransactionNumber(now)
  assert.equal(afterLoss.slice(14), '00006', 'continues after the highest number already issued today')
  assert.ok(!numbers.includes(afterLoss))
  await cashierDb.delete()
})

test('a still-queued sale also holds the counter up', { concurrency: false }, async () => {
  await freshDb()
  const now = new Date(2026, 9, 30, 11, 18, 0)
  const number = await mintTransactionNumber(now)
  await cashierDb.pendingSales.put({ clientSaleId: 'q1', transactionNo: number, createdAt: now.toISOString() })
  await cashierDb.settings.clear()
  assert.equal((await mintTransactionNumber(now)).slice(14), '00002')
  await cashierDb.delete()
})
