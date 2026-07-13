import assert from 'node:assert/strict'
import test from 'node:test'
import { sortTransactionRecords } from '../src/admin-page/utils/transactionLogUtils.js'

const records = [
  { id: 'middle', transactionNo: '2', createdAt: '2026-07-13T03:10:00.000Z' },
  { id: 'oldest', transactionNo: '1', createdAt: '2026-07-13T01:00:00.000Z' },
  { id: 'latest-offline', transactionNo: '3', createdAt: '2026-07-13T06:38:00.000Z' },
]

test('transaction logs sort newest to oldest by default', () => {
  assert.deepEqual(
    sortTransactionRecords(records).map((record) => record.id),
    ['latest-offline', 'middle', 'oldest'],
  )
})

test('transaction logs can reverse to oldest first', () => {
  assert.deepEqual(
    sortTransactionRecords(records, 'oldest').map((record) => record.id),
    ['oldest', 'middle', 'latest-offline'],
  )
})
