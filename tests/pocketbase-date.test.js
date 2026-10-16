import test from 'node:test'
import assert from 'node:assert/strict'
import { toPocketBaseDate } from '../src/utils/pocketBaseDate.js'
import { buildDashboardSalesFilter } from '../src/admin-page/utils/dashboardSalesFilter.js'
import { buildSalesHistoryFilter } from '../src/cashier-pos/utils/salesHistoryFilter.js'
import { buildActivityLogsFilter } from '../src/admin-page/utils/activityLogsFilter.js'

// PocketBase stores dates as "2026-10-15 23:59:47.615Z" (space) and compares
// them as TEXT. A bound written with an ISO "T" sorts after every stored value
// on the same calendar date, so `>=` dropped rows later than the bound and
// `<=` kept rows later than the bound. Measured live: one Philippine business
// day's query returned 354 sales (PHP 64,494) instead of the correct 315
// (PHP 61,994) -- 27 real sales missing, 66 of the next day's included.

test('toPocketBaseDate writes PocketBase\'s stored format: a space, never a "T"', () => {
  assert.equal(toPocketBaseDate('2026-10-15T17:32:30.316Z'), '2026-10-15 17:32:30.316Z')
  assert.equal(toPocketBaseDate(new Date('2026-10-15T17:32:30.316Z')), '2026-10-15 17:32:30.316Z')
})

test('toPocketBaseDate is idempotent and tolerant of empty or unparseable input', () => {
  assert.equal(toPocketBaseDate('2026-10-15 17:32:30.316Z'), '2026-10-15 17:32:30.316Z')
  assert.equal(toPocketBaseDate(''), '')
  assert.equal(toPocketBaseDate(undefined), '')
  assert.equal(toPocketBaseDate(null), '')
  assert.equal(toPocketBaseDate('not-a-date'), 'not-a-date', 'passed through, not guessed at')
})

// The same text comparison PocketBase performs, on real stored values.
const stored = (value) => value // e.g. '2026-10-15 23:59:47.615Z'
const textGte = (row, bound) => stored(row) >= bound
const textLte = (row, bound) => stored(row) <= bound

test('root cause: a raw ISO bound drops later rows on its own date; the converted bound does not', () => {
  const lateSameDay = '2026-10-15 23:59:47.615Z'   // later than the bound below
  const bound = '2026-10-15T17:32:30.316Z'
  assert.equal(textGte(lateSameDay, bound), false, 'the bug: a later row is excluded by the ISO bound')
  assert.equal(textGte(lateSameDay, toPocketBaseDate(bound)), true, 'fixed: it is included')

  const upper = '2026-10-15T15:59:59.999Z'
  const afterUpperSameDay = '2026-10-15 20:00:00.000Z'  // AFTER the upper bound
  assert.equal(textLte(afterUpperSameDay, upper), true, 'the bug: a row past the upper bound is kept')
  assert.equal(textLte(afterUpperSameDay, toPocketBaseDate(upper)), false, 'fixed: it is excluded')
})

test('a Philippine business day selects exactly its own 24 hours', () => {
  // PH 2026-10-15 = 2026-10-14T16:00:00.000Z .. 2026-10-15T15:59:59.999Z
  const { params } = buildDashboardSalesFilter({ fromISO: '2026-10-14T16:00:00.000Z', toISO: '2026-10-15T15:59:59.999Z' })
  const rows = {
    'PH 00:02 of the day (UTC 16:02 the day before)': ['2026-10-14 16:02:00.000Z', true],
    'PH 06:30 of the day':                            ['2026-10-14 22:30:00.000Z', true],
    'PH 23:59 of the day':                            ['2026-10-15 15:59:00.000Z', true],
    'PH 00:00:01 of the NEXT day':                    ['2026-10-15 16:00:01.000Z', false],
    'PH 06:30 of the NEXT day':                       ['2026-10-15 22:30:00.000Z', false],
    'PH 23:59 of the PREVIOUS day':                   ['2026-10-14 15:59:00.000Z', false],
  }
  for (const [label, [row, expected]] of Object.entries(rows)) {
    assert.equal(textGte(row, params.from) && textLte(row, params.to), expected, label)
  }
})

test('all three PocketBase date-range builders send bounds in the stored format', () => {
  const fromISO = '2026-10-14T16:00:00.000Z'
  const toISO = '2026-10-15T15:59:59.999Z'
  const expected = { from: '2026-10-14 16:00:00.000Z', to: '2026-10-15 15:59:59.999Z' }
  assert.deepEqual(buildDashboardSalesFilter({ fromISO, toISO }).params, expected)
  assert.deepEqual(buildActivityLogsFilter({ fromISO, toISO }).params, expected)
  assert.deepEqual(buildSalesHistoryFilter({ fromISO, toISO }).params, expected)
  assert.deepEqual(buildSalesHistoryFilter({ fromISO, toISO, dateField: 'created' }).params, expected)
})
