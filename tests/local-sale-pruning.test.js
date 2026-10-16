import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldPruneLocalCompletedSale } from '../src/admin-page/utils/localSalePruning.js'

// fetchReceiptRecords used to delete every local completedSales row that was
// not in the cloud window it had just loaded. completedSales is the source of
// an OPEN shift's Cash Sales / GCash Sales (getShiftLedgerTotals), so viewing
// an older date range on a terminal mid-shift could remove that shift's own
// synced sales and make its expected cash read low. The cloud data was never
// touched; only the local copy -- but the Z-read variance would be wrong.

const NOW = new Date('2026-10-17T08:00:00.000Z').getTime()
const none = () => new Set()
const ctx = (over = {}) => ({
  pendingIds: none(), pendingTransactionNos: none(), cloudIds: none(), cloudTransactionNos: none(),
  fromISO: '2026-09-01T00:00:00.000Z', toISO: '2026-09-30T23:59:59.999Z', now: NOW, ...over,
})
const sale = (over = {}) => ({ clientSaleId: 'L1', transactionNo: 'T1', createdAt: '2026-09-10T03:00:00.000Z', ...over })

test('a synced sale from the CURRENT shift is not pruned while an older range is being viewed', () => {
  const thisShift = sale({ createdAt: '2026-10-17T02:00:00.000Z' }) // 6h ago, outside the September window
  assert.equal(shouldPruneLocalCompletedSale(thisShift, ctx()), false)
})

test('a sale just uploaded after the cloud list was fetched is not pruned (race guard)', () => {
  const justNow = sale({ createdAt: new Date(NOW - 2 * 60 * 1000).toISOString() })
  assert.equal(shouldPruneLocalCompletedSale(justNow, ctx({ fromISO: '2026-10-01T00:00:00.000Z', toISO: '2026-10-31T23:59:59.999Z' })), false)
})

test('a sale still waiting to sync is never pruned, by id or by transaction number', () => {
  assert.equal(shouldPruneLocalCompletedSale(sale(), ctx({ pendingIds: new Set(['L1']) })), false)
  assert.equal(shouldPruneLocalCompletedSale(sale(), ctx({ pendingTransactionNos: new Set(['T1']) })), false)
})

test('a sale present in the cloud result is kept, matched by id or by transaction number', () => {
  assert.equal(shouldPruneLocalCompletedSale(sale(), ctx({ cloudIds: new Set(['L1']) })), false)
  assert.equal(shouldPruneLocalCompletedSale(sale(), ctx({ cloudTransactionNos: new Set(['T1']) })), false)
})

test('an old, in-window, unsynced-and-absent sale is still pruned (existing cleanup behavior preserved)', () => {
  assert.equal(shouldPruneLocalCompletedSale(sale(), ctx()), true)
})

test('window edges: rows outside either end are never pruned; the edges themselves are in-window', () => {
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: '2026-08-31T23:59:59.000Z' }), ctx()), false, 'before the window')
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: '2026-10-01T00:00:00.000Z' }), ctx()), false, 'after the window')
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: '2026-09-01T00:00:00.000Z' }), ctx()), true, 'exactly at the start')
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: '2026-09-30T23:59:59.999Z' }), ctx()), true, 'exactly at the end')
})

test('with no window at all, an old absent sale is pruned as before; recent ones still are not', () => {
  const open = ctx({ fromISO: null, toISO: null })
  assert.equal(shouldPruneLocalCompletedSale(sale(), open), true)
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: new Date(NOW - 60 * 1000).toISOString() }), open), false)
})

test('a sale with a missing or unreadable date is never pruned', () => {
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: undefined }), ctx()), false)
  assert.equal(shouldPruneLocalCompletedSale(sale({ createdAt: 'garbage' }), ctx()), false)
})
