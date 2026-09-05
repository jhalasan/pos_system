import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { buildCreatedAtRangeFilter } = await import('../server/index.js')

test('buildCreatedAtRangeFilter with both bounds includes both clauses', () => {
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-31T23:59:59.999Z'))
  assert.match(filter, /created_at >= '2026-08-01/)
  assert.match(filter, /created_at <= '2026-08-31/)
  assert.match(filter, /&&/)
})

test('buildCreatedAtRangeFilter with only a from bound omits the to clause', () => {
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), null)
  assert.match(filter, /created_at >= '2026-08-01/)
  assert.equal(filter.includes('&&'), false)
})

test('buildCreatedAtRangeFilter with neither bound returns an empty string', () => {
  assert.equal(buildCreatedAtRangeFilter(null, null), '')
})

test('buildCreatedAtRangeFilter tolerates a legacy row with no created_at at all', () => {
  // Matches the existing /api/receipts precedent (server/index.js:1263-1264):
  // a sale with no created_at should still match rather than being silently
  // excluded, since created_at was backfilled later in this project's history.
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), null)
  assert.match(filter, /created_at = ""/)
})
