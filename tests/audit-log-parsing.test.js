import test from 'node:test'
import assert from 'node:assert/strict'
import { countModeFromDetail, isAdminOverride, hasAdminOverrideMarker } from '../src/admin-page/utils/auditLogUtils.js'

test('count mode stays denomination for normal cashier cash count logs', () => {
  const detail = 'Shift closed by Jane: beginning PHP 1000.00, cash sales PHP 500.00, expected PHP 1500.00, actual PHP 1490.00, variance PHP -10.00, count mode: denomination; denominations: 1x1000, 2x500.'
  assert.equal(countModeFromDetail(detail), 'denomination')
  assert.equal(isAdminOverride(detail), false)
  assert.equal(hasAdminOverrideMarker(detail), false)
})

test('admin override is only flagged when explicitly marked', () => {
  const detail = 'Shift closed by Jane: beginning PHP 1000.00, expected PHP 1500.00, actual PHP 1500.00, variance PHP 0.00, count mode: denomination; admin override: admin'
  assert.equal(countModeFromDetail(detail), 'denomination')
  assert.equal(isAdminOverride(detail), true)
  assert.equal(hasAdminOverrideMarker(detail), true)
})
