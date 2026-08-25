import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { dateKey, weekStart, weekKey, lastDays, lastWeeks, lastMonths, lastYears, phDateParts } = await import('../server/index.js')

// Same root cause as tests/ph-date-range.test.js, but for the Dashboard's
// "Today's Sales" stat and its daily/weekly/monthly/yearly trend charts:
// dateKey/weekStart/lastDays/lastWeeks/lastMonths/lastYears all used Date's
// local getters/setters (getFullYear, getMonth, getDate, getDay, setHours,
// toLocaleString), which reflect the HOST's timezone. On this app's Vercel
// deployment (UTC) that misplaces every calendar boundary 8 hours away from
// the shop's actual Philippines midnight -- e.g. a sale at 6:18 AM PH would
// get bucketed into the previous UTC day. phDateParts and the functions
// built on it anchor every boundary to a fixed +08:00 offset instead.

test('phDateParts: reads year/month/day/hour/dow in PH local time from an unambiguous UTC instant', () => {
  // 2026-08-24T22:18:00Z is 6:18 AM PH on Aug 25 (a Tuesday).
  const parts = phDateParts(new Date('2026-08-24T22:18:00.000Z'))
  assert.deepEqual(parts, { year: 2026, month: 7, day: 25, hour: 6, dow: 2 })
})

test('dateKey: a 6:18 AM PH transaction keys to its own PH day, not the prior UTC day', () => {
  assert.equal(dateKey(new Date('2026-08-24T22:18:00.000Z')), '2026-08-25')
})

test('dateKey: a transaction just before PH midnight still keys to that PH day', () => {
  // 2026-08-25T15:59:59Z is 11:59:59 PM PH on Aug 25.
  assert.equal(dateKey(new Date('2026-08-25T15:59:59.000Z')), '2026-08-25')
  // One second later (2026-08-25T16:00:00Z) is already PH Aug 26.
  assert.equal(dateKey(new Date('2026-08-25T16:00:00.000Z')), '2026-08-26')
})

test('weekStart: returns the PH-midnight instant of that week\'s Sunday', () => {
  // Aug 25 2026 is a Tuesday; that week's Sunday is Aug 23.
  const start = weekStart(new Date('2026-08-24T22:18:00.000Z'))
  assert.equal(start.toISOString(), '2026-08-22T16:00:00.000Z') // PH midnight Aug 23
  assert.equal(dateKey(start), '2026-08-23')
})

test('weekKey: matches dateKey(weekStart(...))', () => {
  const date = new Date('2026-08-24T22:18:00.000Z')
  assert.equal(weekKey(date), dateKey(weekStart(date)))
})

test('lastDays: the most recent bucket is "today" in PH time, keyed correctly', () => {
  const now = new Date('2026-08-24T22:18:00.000Z') // 6:18 AM PH Aug 25
  const days = lastDays(3, now)
  assert.deepEqual(days.map((d) => d.key), ['2026-08-23', '2026-08-24', '2026-08-25'])
})

test('lastWeeks: buckets land on PH Sunday boundaries', () => {
  const now = new Date('2026-08-24T22:18:00.000Z')
  const weeks = lastWeeks(2, now)
  assert.deepEqual(weeks.map((w) => w.key), ['2026-08-16', '2026-08-23'])
})

test('lastMonths: rolls over year boundaries correctly using PH calendar month', () => {
  const now = new Date('2026-01-24T20:00:00.000Z') // 4:00 AM PH Jan 25, 2026
  const months = lastMonths(3, now)
  assert.deepEqual(months.map((m) => m.key), ['2025-11', '2025-12', '2026-01'])
})

test('lastYears: uses the PH calendar year, not the host/UTC year', () => {
  // 2025-12-31T20:00:00Z is 4:00 AM PH on Jan 1, 2026 -- UTC still says 2025.
  const now = new Date('2025-12-31T20:00:00.000Z')
  const years = lastYears(2, now)
  assert.deepEqual(years.map((y) => y.key), ['2025', '2026'])
})
