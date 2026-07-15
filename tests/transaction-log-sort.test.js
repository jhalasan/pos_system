import assert from 'node:assert/strict'
import test from 'node:test'
import { sortTransactionRecords } from '../src/admin-page/utils/transactionLogUtils.js'

const records = [
  { id: 'middle', transactionNo: '2', createdAt: '2026-07-13T03:10:00.000Z', totalAmount: 300, customerName: 'Zed', cashierName: 'Amy' },
  { id: 'oldest', transactionNo: '1', createdAt: '2026-07-13T01:00:00.000Z', totalAmount: 100, customerName: 'Ana', cashierName: 'Zoe' },
  { id: 'latest-offline', transactionNo: '3', createdAt: '2026-07-13T06:38:00.000Z', totalAmount: 200, customerName: 'Ben', cashierName: 'May' },
]

test('transaction logs sort newest to oldest by default', () => {
  assert.deepEqual(
    sortTransactionRecords(records).map((record) => record.id),
    ['latest-offline', 'middle', 'oldest'],
  )
})

test('transaction logs sort by total, customer, and cashier', () => {
  assert.deepEqual(sortTransactionRecords(records, 'total-high').map((record) => record.id), ['middle', 'latest-offline', 'oldest'])
  assert.deepEqual(sortTransactionRecords(records, 'customer').map((record) => record.id), ['oldest', 'latest-offline', 'middle'])
  assert.deepEqual(sortTransactionRecords(records, 'cashier').map((record) => record.id), ['middle', 'latest-offline', 'oldest'])
})

test('transaction logs can reverse to oldest first', () => {
  assert.deepEqual(
    sortTransactionRecords(records, 'oldest').map((record) => record.id),
    ['oldest', 'middle', 'latest-offline'],
  )
})
