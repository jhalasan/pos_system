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

// M36: growing one cart line's quantity must count a SIBLING line of the
// same product in the SAME cart against available stock (e.g. one line sold
// as a Piece, another as a Case of the same product) -- Cashier.jsx's
// quantity-stepper check used to pass excludedTransactionId for the whole
// active tab, which hid every sibling line, not just the one being edited.
// The fix calls this with excludedTransactionId: null and only
// excludedCartItemId set to the line actually being edited.
test('M36: a sibling line of the same product in the SAME transaction counts against availability when only excludedCartItemId is set (the fixed call pattern)', () => {
  const transactions = [
    txn(1, {
      cartItems: [
        cartItem('p1', 30, { id: 'case-line', conversion: 24 }), // a Case line: 30*24=720 base units already reserved
        cartItem('p1', 2, { id: 'piece-line', conversion: 1 }),  // the Piece line being grown
      ],
    }),
  ]
  // Fixed call pattern: exclude only the line being edited, not the whole transaction.
  const detail = reservedQuantityDetail(transactions, 'p1', { excludedTransactionId: null, excludedCartItemId: 'piece-line' })
  assert.equal(detail.reservedBaseQty, 720) // the Case line's reservation is correctly counted
})

test('M36: documents the pre-fix bug -- excluding the whole transaction hides a sibling line entirely', () => {
  const transactions = [
    txn(1, {
      cartItems: [
        cartItem('p1', 30, { id: 'case-line', conversion: 24 }),
        cartItem('p1', 2, { id: 'piece-line', conversion: 1 }),
      ],
    }),
  ]
  // The old, buggy call pattern: excludedTransactionId set to the active tab.
  const detail = reservedQuantityDetail(transactions, 'p1', { excludedTransactionId: 1, excludedCartItemId: 'piece-line' })
  assert.equal(detail.reservedBaseQty, 0) // bug: the Case line's 720 reserved units vanish from the count
})
