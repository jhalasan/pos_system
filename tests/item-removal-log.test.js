import test from 'node:test'
import assert from 'node:assert/strict'
import { ITEM_REMOVED_ACTION, buildItemRemovalLog, parseItemRemovalLog } from '../src/utils/itemRemovalLog.js'

// A cashier can delete cart lines before payment without a manager, so the
// manager-approved "Void this transaction" could be bypassed one line at a
// time with no trace. Every removal is now logged, and the admin Audit page
// reads count and peso value back from that text -- these pin the format both
// sides share.

test('a removed line round-trips through the log: quantity and peso value', () => {
  const log = buildItemRemovalLog({ cashierName: 'ARLIE VELASCO', name: 'Coke 1.5L', removedQty: 2, unitPrice: 85, fromQty: 2, toQty: 0, transactionNo: '20261017001' })

  assert.equal(log.action, ITEM_REMOVED_ACTION)
  assert.match(log.detail, /line removed/)
  assert.deepEqual(parseItemRemovalLog(log), { qty: 2, value: 170 })
})

test('a reduced quantity logs only what was taken out, and says from/to', () => {
  const log = buildItemRemovalLog({ cashierName: 'ARLIE VELASCO', name: 'Egg tray', removedQty: 2, unitPrice: 250.5, fromQty: 5, toQty: 3, transactionNo: 'T1' })

  assert.match(log.detail, /quantity reduced from 5 to 3/)
  assert.deepEqual(parseItemRemovalLog(log), { qty: 2, value: 501 })
})

test('fractional quantities and large values survive the round trip', () => {
  const log = buildItemRemovalLog({ cashierName: 'C', name: 'Rice', removedQty: 1.5, unitPrice: 1234.5, fromQty: 1.5, toQty: 0, transactionNo: 'T2' })
  assert.deepEqual(parseItemRemovalLog(log), { qty: 1.5, value: 1851.75 })

  const bulk = buildItemRemovalLog({ cashierName: 'C', name: 'Sachet', removedQty: 1200, unitPrice: 10, fromQty: 1200, toQty: 0, transactionNo: 'T3' })
  assert.deepEqual(parseItemRemovalLog(bulk), { qty: 1200, value: 12000 })
})

test('the cashier name is the first "by NAME;" so the Audit page attributes it to the right row', () => {
  // Same regex Audit.jsx's cashierNameFromDetail uses; the product name (here
  // containing "by") must not be mistaken for the cashier.
  const log = buildItemRemovalLog({ cashierName: 'ARLIE VELASCO', name: 'Made by Nestle; Milk', removedQty: 1, unitPrice: 50, fromQty: 1, toQty: 0, transactionNo: 'T4' })
  const cashier = log.detail.match(/by\s+(.+?)(?:\.|;|\s+Device)/i)?.[1]

  assert.equal(cashier, 'ARLIE VELASCO')
  assert.doesNotMatch(log.detail.split('; ').slice(1).join('; '), /;\s*Milk/, 'a ";" in a product name must not break the field layout')
})

test('parsing ignores unrelated log actions', () => {
  assert.equal(parseItemRemovalLog({ action: 'Transaction Void', detail: 'removed qty 5; value PHP 10.00' }), null)
})
