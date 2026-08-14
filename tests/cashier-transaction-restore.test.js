import test from 'node:test'
import assert from 'node:assert/strict'

import { restoreCashierTransactions } from '../src/cashier-pos/utils/transactionRestore.js'

const createTransaction = (id) => ({ id, status: 'open', cartItems: [] })

test('restoring a cashier with a completed active tab selects an existing open tab', () => {
  const restored = restoreCashierTransactions({
    activeTransaction: 4,
    transactions: [
      { id: 4, status: 'completed', cartItems: [] },
      { id: 7, status: 'open', cartItems: [] },
    ],
  }, createTransaction)

  assert.equal(restored.activeTransaction, 7)
  assert.equal(restored.nextTransactionId, 8)
  assert.equal(restored.transactions.length, 2)
})

test('restoring a cashier with only locked tabs creates a fresh unique transaction', () => {
  const restored = restoreCashierTransactions({
    activeTransaction: 2,
    transactions: [
      { id: 2, status: 'completed', cartItems: [] },
      { id: 5, status: 'voided', cartItems: [] },
    ],
  }, createTransaction)

  assert.equal(restored.activeTransaction, 6)
  assert.equal(restored.nextTransactionId, 7)
  assert.equal(restored.transactions.at(-1).status, 'open')
})

test('restored transaction IDs are not reused when the active tab is already open', () => {
  const restored = restoreCashierTransactions({
    activeTransaction: 9,
    transactions: [{ id: 9, status: 'open', cartItems: [] }],
  }, createTransaction)

  assert.equal(restored.activeTransaction, 9)
  assert.equal(restored.nextTransactionId, 10)
})
