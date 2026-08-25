import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { getShiftLedgerTotals } from '../src/cashier-pos/offline/saleRepository.js'

// Root cause of a live client report: a cashier's hand-tallied shift total
// (P2,773) came out far higher than the terminal's own shift-close report
// (P1,347), while the underlying sales were confirmed complete and correct
// in the cloud. Traced to Cashier.jsx computing "Cash Sales" from a
// localStorage-cached running total that can silently lose entries across a
// crash/restart (see the design spec). getShiftLedgerTotals recomputes the
// figure from cashierDb.completedSales -- the same durable, transactional
// local table every sale/void/refund already writes to -- so the number is
// always correct regardless of what happened to any in-memory/localStorage
// state.

function completedSale(overrides = {}) {
  return {
    clientSaleId: overrides.clientSaleId || `sale-${Math.random().toString(36).slice(2)}`,
    cashierId: 'cashier-1',
    transactionNo: 'TXN-1',
    status: 'completed',
    paymentMethod: 'cash',
    totalAmount: 100,
    cashAmount: 100,
    gcashAmount: 0,
    splitPayments: { cash: 0, gcash: 0, gcashRef: '' },
    adjustments: [],
    createdAt: '2026-08-25T08:00:00.000Z',
    ...overrides,
  }
}

test('getShiftLedgerTotals sums completed cash and gcash sales separately', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'a', paymentMethod: 'cash', totalAmount: 100, cashAmount: 100 }),
    completedSale({ clientSaleId: 'b', paymentMethod: 'gcash', totalAmount: 50, gcashAmount: 50 }),
    completedSale({ clientSaleId: 'c', paymentMethod: 'cash', totalAmount: 25, cashAmount: 25 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 125)
  assert.equal(totals.gcashSales, 50)

  await cashierDb.delete()
})

test('getShiftLedgerTotals excludes voided sales entirely', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'a', totalAmount: 100, cashAmount: 100 }),
    completedSale({ clientSaleId: 'b', status: 'voided', totalAmount: 60, cashAmount: 60 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 100)

  await cashierDb.delete()
})

test('getShiftLedgerTotals nets a partial refund via adjustments', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.put(completedSale({
    clientSaleId: 'a',
    status: 'adjusted',
    totalAmount: 100,
    cashAmount: 100,
    adjustments: [{ type: 'refund', amount: 30 }],
  }))

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 70)

  await cashierDb.delete()
})

test('getShiftLedgerTotals splits a split-payment sale correctly instead of treating it as pure cash', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  // Stored exactly as Cashier.jsx/finalizeSaleLocally actually store a split
  // sale today: paymentMethod coerced to 'cash' (PocketBase's payment_method
  // enum has no 'split' value), with the true breakdown in splitPayments.
  await cashierDb.completedSales.put(completedSale({
    clientSaleId: 'a',
    paymentMethod: 'cash',
    totalAmount: 100,
    cashAmount: 60,
    gcashAmount: 40,
    splitPayments: { cash: 60, gcash: 40, gcashRef: 'REF123' },
  }))

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 60, 'must use the cash portion, not the full total')
  assert.equal(totals.gcashSales, 40, 'must use the gcash portion')

  await cashierDb.delete()
})

test('getShiftLedgerTotals respects the sinceISO lower bound', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'before', totalAmount: 999, cashAmount: 999, createdAt: '2026-08-24T23:00:00.000Z' }),
    completedSale({ clientSaleId: 'after', totalAmount: 50, cashAmount: 50, createdAt: '2026-08-25T01:00:00.000Z' }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 50, 'a sale from a previous, already-closed shift must not bleed into this one')

  await cashierDb.delete()
})

test('getShiftLedgerTotals only counts the given cashier', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'mine', cashierId: 'cashier-1', totalAmount: 40, cashAmount: 40 }),
    completedSale({ clientSaleId: 'theirs', cashierId: 'cashier-2', totalAmount: 999, cashAmount: 999 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 40)

  await cashierDb.delete()
})

test('getShiftLedgerTotals returns zeros for a missing cashierId', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  const totals = await getShiftLedgerTotals('', '2026-08-25T00:00:00.000Z')
  assert.deepEqual(totals, { cashSales: 0, gcashSales: 0 })
  await cashierDb.delete()
})

// This is the actual guarantee the whole fix provides: the number is
// correct from Dexie alone, with zero dependency on any in-memory or
// localStorage state -- i.e. it survives exactly the kind of crash/restart
// that caused the original bug.
test('getShiftLedgerTotals reconstructs the full shift total with no in-memory or localStorage state involved', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  const sales = Array.from({ length: 20 }, (_, i) => completedSale({
    clientSaleId: `sale-${i}`,
    totalAmount: 10,
    cashAmount: 10,
    createdAt: `2026-08-25T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:00:00.000Z`,
  }))
  await cashierDb.completedSales.bulkPut(sales)

  // No localStorage global exists in this test at all -- simulating a fresh
  // process where nothing but the Dexie table survived.
  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 200)

  await cashierDb.delete()
})
