import test from 'node:test'
import assert from 'node:assert/strict'
import { toCashierSale, toCashierCloudSale } from '../src/cashier-pos/utils/cashierSaleMapping.js'
import { buildReceiptText } from '../src/cashier-pos/services/receiptPrinter.js'

// Client-reported: the customer name printed on the first receipt but not on a
// reprint. The reprint reads the sale from these mappers, and neither used to
// copy the name.

const localSale = {
  clientSaleId: 'local-1', transactionNo: 'T100', totalAmount: 250, subtotalAmount: 250,
  paymentMethod: 'cash', cashAmount: 300, change: 50, status: 'completed', syncStatus: 'synced',
  createdAt: '2026-10-17T02:00:00.000Z', cashierId: 'c1', cashierName: 'ARLIE VELASCO',
  customerName: 'Juan Dela Cruz', items: [{ name: 'Coke', quantity: 2, price: 125 }],
}

test('a local sale keeps its customer name through toCashierSale', () => {
  assert.equal(toCashierSale(localSale).customerName, 'Juan Dela Cruz')
  assert.equal(toCashierSale({ ...localSale, customerName: undefined }).customerName, '', 'no name -> empty string, not undefined')
})

test('a cloud sale carries customer_name through toCashierCloudSale', () => {
  const cloud = {
    id: 'cloud1', transaction_no: 'T200', total_amount: 90, subtotal_amount: 90, payment_method: 'gcash',
    status: 'completed', created_at: '2026-10-17 02:00:00.000Z', cashier_id: 'c1', customer_name: 'Maria Santos',
  }
  assert.equal(toCashierCloudSale(cloud, []).customerName, 'Maria Santos')
  assert.equal(toCashierCloudSale({ ...cloud, customer_name: '' }, []).customerName, '')
  assert.equal(toCashierCloudSale({ ...cloud, customer_name: undefined }, []).customerName, '')
})

test('end to end: a mapped sale prints its customer name on the reprint', () => {
  const sale = toCashierSale(localSale)
  const text = buildReceiptText({
    transactionNo: sale.transactionNo, cashierName: sale.cashierName, customerName: sale.customerName,
    completedAt: sale.createdAt, items: sale.items,
    payment: { paymentMethod: sale.paymentMethod, totalAmount: sale.totalAmount, subtotalAmount: sale.subtotalAmount, cashAmount: sale.cashAmount, change: sale.change },
  })
  assert.match(text, /Customer\s+Juan Dela Cruz/)
})

// The mappers were moved out of desktopApi.js verbatim; pin the behavior the
// move must not change.
test('mapper behavior is unchanged: status labels, ids and split payments', () => {
  assert.equal(toCashierSale({ ...localSale, status: 'voided' }).status, 'Voided')
  assert.equal(toCashierSale({ ...localSale, adjustments: [{ amount: 10 }] }).status, 'Adjusted')
  assert.equal(toCashierSale({ ...localSale, syncStatus: 'pending' }).status, 'Pending sync')
  assert.equal(toCashierSale(localSale).status, 'Completed')
  assert.equal(toCashierSale(localSale).id, 'local-1')
  assert.equal(toCashierSale(localSale).itemCount, 2)

  const split = toCashierSale({ ...localSale, refNumber: 'split:{"cash":100,"gcash":150,"gcashRef":"R1"}' })
  assert.equal(split.paymentMethod, 'split')
  assert.deepEqual(split.splitPayments, { cash: 100, gcash: 150, gcashRef: 'R1' })
  assert.equal(split.refNumber, '')

  const cloud = toCashierCloudSale({ id: 'c9', transaction_no: 'T9', total_amount: 40, payment_method: 'cash', status: 'completed', created_at: '2026-10-17 01:00:00.000Z', cashier_id: ['c1'] }, [{ name: 'X', quantity: 1, price: 40 }])
  assert.equal(cloud.syncStatus, 'synced')
  assert.equal(cloud.cashierId, 'c1')
  assert.equal(cloud.cashAmount, 40)
})
