import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { getCompletedSales, getPendingSales } from '../src/cashier-pos/offline/saleRepository.js'
import {
  startOfLocalDay,
  endOfLocalDay,
  toDateInputValue,
  dateInputValueToDate,
  addDays,
  isToday,
} from '../src/cashier-pos/utils/historyDateRange.js'
import { buildSalesHistoryFilter } from '../src/cashier-pos/utils/salesHistoryFilter.js'

// Root cause of a live client report: the "Recent Transactions" list claimed
// to show "today" (Cashier.jsx's own empty-state text) but had no date bound
// at all -- every prior day's transactions were mixed in, and every
// PocketBase sale/sale_item ever recorded was re-downloaded on every open,
// getting slower every day the shop operates. These tests cover the pure
// date-boundary helpers, the local Dexie date-range reads, and the
// PocketBase filter-string construction that fixes it.

test('startOfLocalDay/endOfLocalDay bound a full local calendar day', () => {
  const mid = new Date(2026, 7, 27, 14, 30, 0) // Aug 27 2026, 2:30pm local
  const start = startOfLocalDay(mid)
  const end = endOfLocalDay(mid)
  assert.equal(start.getHours(), 0)
  assert.equal(start.getMinutes(), 0)
  assert.equal(start.getSeconds(), 0)
  assert.equal(start.getMilliseconds(), 0)
  assert.equal(end.getHours(), 23)
  assert.equal(end.getMinutes(), 59)
  assert.equal(end.getSeconds(), 59)
  assert.equal(end.getMilliseconds(), 999)
  assert.equal(start.getDate(), 27)
  assert.equal(end.getDate(), 27)
});

test('toDateInputValue/dateInputValueToDate round-trip on the local calendar day', () => {
  const original = new Date(2026, 7, 27, 23, 45, 0) // late in the day, local time
  const value = toDateInputValue(original)
  assert.equal(value, '2026-08-27')
  const parsed = dateInputValueToDate(value)
  // Regression guard: `new Date('2026-08-27')` (no time component) parses as
  // UTC midnight, which in a timezone behind UTC would resolve to the
  // *previous* local day. Parsing through dateInputValueToDate must not.
  assert.equal(parsed.getFullYear(), 2026)
  assert.equal(parsed.getMonth(), 7)
  assert.equal(parsed.getDate(), 27)
  assert.equal(parsed.getHours(), 0)
});

test('addDays crosses a month boundary correctly', () => {
  const aug31 = new Date(2026, 7, 31)
  const sep1 = addDays(aug31, 1)
  assert.equal(sep1.getMonth(), 8)
  assert.equal(sep1.getDate(), 1)
  const backToAug31 = addDays(sep1, -1)
  assert.equal(toDateInputValue(backToAug31), toDateInputValue(aug31))
});

test('isToday is true only for the current local calendar day', () => {
  assert.equal(isToday(new Date()), true)
  assert.equal(isToday(addDays(new Date(), -1)), false)
  assert.equal(isToday(addDays(new Date(), 1)), false)
});

function completedSale(overrides = {}) {
  return {
    clientSaleId: overrides.clientSaleId || `sale-${Math.random().toString(36).slice(2)}`,
    cashierId: 'cashier-1',
    transactionNo: overrides.transactionNo || 'TXN-1',
    status: 'completed',
    paymentMethod: 'cash',
    totalAmount: 100,
    cashAmount: 100,
    gcashAmount: 0,
    createdAt: '2026-08-27T08:00:00.000Z',
    ...overrides,
  }
}

test('getCompletedSales with a date range returns only that day, not everything ever recorded', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'yesterday', transactionNo: 'YDAY', createdAt: '2026-08-26T10:00:00.000Z' }),
    completedSale({ clientSaleId: 'today-1', transactionNo: 'TODAY1', createdAt: '2026-08-27T02:00:00.000Z' }),
    completedSale({ clientSaleId: 'today-2', transactionNo: 'TODAY2', createdAt: '2026-08-27T22:00:00.000Z' }),
    completedSale({ clientSaleId: 'tomorrow', transactionNo: 'TMRW', createdAt: '2026-08-28T01:00:00.000Z' }),
  ])

  const sales = await getCompletedSales({
    fromISO: '2026-08-27T00:00:00.000Z',
    toISO: '2026-08-27T23:59:59.999Z',
  })

  assert.equal(sales.length, 2)
  assert.deepEqual(
    sales.map((sale) => sale.transactionNo).sort(),
    ['TODAY1', 'TODAY2'],
  )

  await cashierDb.delete()
});

test('getCompletedSales with no range still returns everything (unchanged default behavior)', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'a', createdAt: '2026-08-01T00:00:00.000Z' }),
    completedSale({ clientSaleId: 'b', createdAt: '2026-08-27T00:00:00.000Z' }),
  ])

  const sales = await getCompletedSales()
  assert.equal(sales.length, 2)

  await cashierDb.delete()
});

function pendingSale(overrides = {}) {
  return {
    clientSaleId: overrides.clientSaleId || `pending-${Math.random().toString(36).slice(2)}`,
    cashierId: 'cashier-1',
    status: 'pending',
    createdAt: '2026-08-27T08:00:00.000Z',
    ...overrides,
  }
}

test('getPendingSales with a date range excludes an older stuck pending sale', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.pendingSales.bulkPut([
    pendingSale({ clientSaleId: 'stuck-old', createdAt: '2026-08-20T00:00:00.000Z' }),
    pendingSale({ clientSaleId: 'todays', createdAt: '2026-08-27T05:00:00.000Z' }),
  ])

  const sales = await getPendingSales({
    fromISO: '2026-08-27T00:00:00.000Z',
    toISO: '2026-08-27T23:59:59.999Z',
  })

  assert.equal(sales.length, 1)
  assert.equal(sales[0].clientSaleId, 'todays')

  await cashierDb.delete()
});

test('buildSalesHistoryFilter combines cashierId and a date range with AND', () => {
  const { filter, params } = buildSalesHistoryFilter({
    cashierId: 'cashier-1',
    fromISO: '2026-08-27T00:00:00.000Z',
    toISO: '2026-08-27T23:59:59.999Z',
  })
  assert.equal(filter, 'cashier_id = {:cashierId} && created_at >= {:from} && created_at <= {:to}')
  assert.deepEqual(params, {
    cashierId: 'cashier-1',
    from: '2026-08-27T00:00:00.000Z',
    to: '2026-08-27T23:59:59.999Z',
  })
});

test('buildSalesHistoryFilter omits the cashier clause entirely when no cashierId is given (the "all cashiers" default)', () => {
  const { filter, params } = buildSalesHistoryFilter({
    fromISO: '2026-08-27T00:00:00.000Z',
    toISO: '2026-08-27T23:59:59.999Z',
  })
  assert.equal(filter, 'created_at >= {:from} && created_at <= {:to}')
  assert.ok(!('cashierId' in params))
});

test('buildSalesHistoryFilter supports a custom dateField for sale_items (no created_at column there)', () => {
  const { filter } = buildSalesHistoryFilter({
    fromISO: '2026-08-27T00:00:00.000Z',
    toISO: '2026-08-27T23:59:59.999Z',
    dateField: 'created',
  })
  assert.equal(filter, 'created >= {:from} && created <= {:to}')
});

test('receiptCache date-bounded read excludes an old cached row from a previous day', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.receiptCache.bulkPut([
    { id: 'old', transactionNo: 'OLD', cashierId: 'cashier-1', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'today', transactionNo: 'TODAY', cashierId: 'cashier-1', createdAt: '2026-08-27T10:00:00.000Z' },
  ])

  const rows = await cashierDb.receiptCache
    .where('createdAt').between('2026-08-27T00:00:00.000Z', '2026-08-27T23:59:59.999Z', true, true)
    .toArray()

  assert.equal(rows.length, 1)
  assert.equal(rows[0].transactionNo, 'TODAY')

  await cashierDb.delete()
});
