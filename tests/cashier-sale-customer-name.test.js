import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReceiptText } from '../src/cashier-pos/services/receiptPrinter.js'

// Client-reported: the customer name printed on the first receipt but vanished
// on every reprint. Two things dropped it -- the cashier sale mappers in
// desktopApi.js never copied customerName / customer_name, and the three
// reprint handlers in Cashier.jsx never passed it to the receipt builder.
// This pins the printer contract the reprint handlers rely on.
test('a receipt prints the customer name when one is supplied, and omits the line when not', () => {
  const base = {
    transactionNo: 'TXN-1',
    cashierName: 'Cashier One',
    completedAt: '2026-07-08T10:00:00.000Z',
    items: [{ name: 'Widget', quantity: 1, price: 10 }],
    payment: { paymentMethod: 'cash', totalAmount: 10, subtotalAmount: 10, cashAmount: 10, change: 0 },
  }

  assert.match(buildReceiptText({ ...base, customerName: 'Juan Dela Cruz' }), /Customer\s+Juan Dela Cruz/)
  assert.doesNotMatch(buildReceiptText({ ...base, customerName: '' }), /Customer/)
})
