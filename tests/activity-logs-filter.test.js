import test from 'node:test'
import assert from 'node:assert/strict'
import { buildActivityLogsFilter } from '../src/admin-page/utils/activityLogsFilter.js'

test('buildActivityLogsFilter with both bounds', () => {
  const { filter, params } = buildActivityLogsFilter({ fromISO: '2026-09-01T00:00:00.000Z', toISO: '2026-09-05T23:59:59.999Z' })
  assert.equal(filter, 'timestamp >= {:from} && timestamp <= {:to}')
  assert.deepEqual(params, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-05T23:59:59.999Z' })
})

test('buildActivityLogsFilter with only a lower bound', () => {
  const { filter, params } = buildActivityLogsFilter({ fromISO: '2026-09-01T00:00:00.000Z' })
  assert.equal(filter, 'timestamp >= {:from}')
  assert.deepEqual(params, { from: '2026-09-01T00:00:00.000Z' })
})

test('buildActivityLogsFilter with no bounds returns an empty filter', () => {
  const { filter, params } = buildActivityLogsFilter()
  assert.equal(filter, '')
  assert.deepEqual(params, {})
})
