import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDashboardSalesFilter } from '../src/admin-page/utils/dashboardSalesFilter.js'

test('buildDashboardSalesFilter with both bounds', () => {
  const { filter, params } = buildDashboardSalesFilter({ fromISO: '2026-08-01T00:00:00.000Z', toISO: '2026-08-31T23:59:59.999Z' })
  assert.equal(filter, 'created_at >= {:from} && created_at <= {:to}')
  assert.deepEqual(params, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
})

test('buildDashboardSalesFilter with no bounds ("All Time") returns an empty filter', () => {
  const { filter, params } = buildDashboardSalesFilter()
  assert.equal(filter, '')
  assert.deepEqual(params, {})
})
