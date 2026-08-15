import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reservedQuantityDetail } from '../src/cashier-pos/utils/cartReservation.js'

// M7: a stray open transaction tab silently blocks adding an in-stock
// product, with no indication why -- see POS_AUDIT_REGISTER.md. These tests
// cover the extracted pure aggregation behind that check.

function txn(id, { status = 'open', name = `Tab ${id}`, cartItems = [] } = {}) {
  return { id, status, name, cartItems }
}

function cartItem(productId, quantity, { id = `${productId}:item`, conversion = 1 } = {}) {
  return { id, productId, quantity, conversion }
}

test('sums reserved quantity for a product across multiple open tabs', () => {
  const transactions = [
    txn(1, { cartItems: [cartItem('p1', 2)] }),
    txn(2, { cartItems: [cartItem('p1', 3)] }),
  ]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.reservedBaseQty, 5)
  assert.equal(detail.holdingTransactions.length, 2)
})

test('applies unit conversion when summing reserved base quantity', () => {
  const transactions = [txn(1, { cartItems: [cartItem('p1', 2, { conversion: 24 })] })]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.reservedBaseQty, 48)
})

test('ignores completed and voided transactions', () => {
  const transactions = [
    txn(1, { status: 'completed', cartItems: [cartItem('p1', 5)] }),
    txn(2, { status: 'voided', cartItems: [cartItem('p1', 5)] }),
  ]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.reservedBaseQty, 0)
  assert.equal(detail.holdingTransactions.length, 0)
})

test('excludedTransactionId skips that entire transaction', () => {
  const transactions = [
    txn(1, { cartItems: [cartItem('p1', 2)] }),
    txn(2, { cartItems: [cartItem('p1', 3)] }),
  ]
  const detail = reservedQuantityDetail(transactions, 'p1', { excludedTransactionId: 1 })
  assert.equal(detail.reservedBaseQty, 3)
})

test('excludedCartItemId skips only that cart line, not the whole transaction', () => {
  const transactions = [
    txn(1, { cartItems: [cartItem('p1', 2, { id: 'line-a' }), cartItem('p1', 4, { id: 'line-b' })] }),
  ]
  const detail = reservedQuantityDetail(transactions, 'p1', { excludedCartItemId: 'line-a' })
  assert.equal(detail.reservedBaseQty, 4)
})

test('ignores other products entirely', () => {
  const transactions = [txn(1, { cartItems: [cartItem('p2', 10)] })]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.reservedBaseQty, 0)
})

test('a tab with zero reserved quantity for the product is not listed as holding', () => {
  const transactions = [txn(1, { cartItems: [] }), txn(2, { cartItems: [cartItem('p1', 1)] })]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.holdingTransactions.length, 1)
  assert.equal(detail.holdingTransactions[0].id, 2)
})

test('holdingTransactions carries the tab name for message-building', () => {
  const transactions = [txn(7, { name: 'Sale 7', cartItems: [cartItem('p1', 1)] })]
  const detail = reservedQuantityDetail(transactions, 'p1')
  assert.equal(detail.holdingTransactions[0].name, 'Sale 7')
})

test('handles missing/malformed transactions gracefully', () => {
  assert.doesNotThrow(() => reservedQuantityDetail(null, 'p1'))
  assert.doesNotThrow(() => reservedQuantityDetail([null, undefined, txn(1)], 'p1'))
  assert.equal(reservedQuantityDetail(null, 'p1').reservedBaseQty, 0)
})
