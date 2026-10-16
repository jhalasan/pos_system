import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_LOG_FIELDS, parseActivityLogRange } from '../src/utils/activityLogRange.js'
import { buildActivityLogsFilter } from '../src/admin-page/utils/activityLogsFilter.js'
import { toActivityLog } from '../server/formatters.js'

// /api/activity-logs used to return the whole collection (~60,000 rows, 13 MB)
// on every call -- past Vercel's ~4.5 MB response limit. It now takes a date
// range, and these pin how that range is read and applied.

test('an omitted range stays open-ended on both sides', () => {
  assert.deepEqual(parseActivityLogRange({}), { fromISO: '', toISO: '' })
  assert.deepEqual(parseActivityLogRange(), { fromISO: '', toISO: '' })
  assert.deepEqual(parseActivityLogRange({ fromDate: '', toDate: '   ' }), { fromISO: '', toISO: '' })
})

test('Dates and ISO strings are both normalized to an ISO instant', () => {
  const range = parseActivityLogRange({
    fromDate: new Date('2026-10-16T00:00:00.000Z'),
    toDate: '2026-10-16T15:59:59.999Z',
  })
  assert.deepEqual(range, { fromISO: '2026-10-16T00:00:00.000Z', toISO: '2026-10-16T15:59:59.999Z' })
})

test('one-sided ranges are allowed (the admin bell asks for "the last 14 days" with no end)', () => {
  assert.deepEqual(parseActivityLogRange({ fromDate: '2026-10-01T00:00:00.000Z' }), { fromISO: '2026-10-01T00:00:00.000Z', toISO: '' })
  assert.deepEqual(parseActivityLogRange({ toDate: '2026-10-01T00:00:00.000Z' }), { fromISO: '', toISO: '2026-10-01T00:00:00.000Z' })
})

test('a malformed or inverted range is rejected instead of silently returning every log', () => {
  assert.throws(() => parseActivityLogRange({ fromDate: 'not-a-date' }), RangeError)
  assert.throws(() => parseActivityLogRange({ toDate: '31/31/2026' }), RangeError)
  assert.throws(() => parseActivityLogRange({ fromDate: '2026-10-17T00:00:00.000Z', toDate: '2026-10-16T00:00:00.000Z' }), RangeError)
})

test('the parsed range drives the same PocketBase filter the desktop admin uses', () => {
  const { fromISO, toISO } = parseActivityLogRange({ fromDate: '2026-10-16T00:00:00.000Z', toDate: '2026-10-16T15:59:59.999Z' })
  const { filter, params } = buildActivityLogsFilter({ fromISO, toISO })
  assert.equal(filter, 'timestamp >= {:from} && timestamp <= {:to}')
  assert.deepEqual(params, { from: '2026-10-16 00:00:00.000Z', to: '2026-10-16 15:59:59.999Z' })
  assert.equal(buildActivityLogsFilter(parseActivityLogRange({})).filter, '', 'no range -> no filter (explicit "all dates")')
})

test('a slimmed record (only ACTIVITY_LOG_FIELDS) maps to exactly the same log as the full record', () => {
  const full = {
    id: 'log1', collectionId: 'c', collectionName: 'activity_logs',
    action_type: 'Item Removed', description: 'Item removed by ARLIE; Coke; removed qty 1; value PHP 85.00',
    timestamp: '2026-10-16 17:09:48.600Z', created: '2026-10-16 17:09:49.000Z', updated: '2026-10-16 17:09:49.000Z',
    user_id: 'u1',
    expand: { user_id: { id: 'u1', email: 'arlie@example.com', name: 'ARLIE VELASCO', role: 'cashier', avatar: 'a.png', verified: true, tokenKey: 'x', created: '2026-01-01' } },
  }
  const keep = new Set(ACTIVITY_LOG_FIELDS.split(','))
  const slim = {
    id: full.id, action_type: full.action_type, description: full.description,
    timestamp: full.timestamp, created: full.created, user_id: full.user_id,
    expand: { user_id: { name: full.expand.user_id.name, email: full.expand.user_id.email, role: full.expand.user_id.role } },
  }
  for (const field of ['id', 'action_type', 'description', 'timestamp', 'created', 'user_id', 'expand.user_id.name', 'expand.user_id.email', 'expand.user_id.role']) {
    assert.ok(keep.has(field), `ACTIVITY_LOG_FIELDS must include ${field}, which the log mappers read`)
  }
  assert.deepEqual(toActivityLog(slim), toActivityLog(full))
})

import { buildActivityLogQuery } from '../src/utils/activityLogRange.js'
import { computeAuditLogWindow, AUDIT_LOG_WINDOW_PADDING_MS } from '../src/admin-page/utils/auditLogWindow.js'

test('the web client sends a range as ISO instants, and nothing when unbounded', () => {
  assert.equal(buildActivityLogQuery(), '')
  assert.equal(buildActivityLogQuery(null), '')
  assert.equal(buildActivityLogQuery({}), '')
  assert.equal(buildActivityLogQuery({ fromDate: '', toDate: undefined }), '')
  assert.equal(
    buildActivityLogQuery({ fromDate: new Date('2026-10-16T00:00:00.000Z'), toDate: '2026-10-16T15:59:59.999Z' }),
    '?fromDate=2026-10-16T00%3A00%3A00.000Z&toDate=2026-10-16T15%3A59%3A59.999Z',
  )
  assert.equal(buildActivityLogQuery({ fromDate: '2026-10-01T00:00:00.000Z' }), '?fromDate=2026-10-01T00%3A00%3A00.000Z', 'one-sided (the admin bell)')
  assert.equal(buildActivityLogQuery({ fromDate: 'garbage' }), '', 'an unreadable side is left open, not sent')
})

test('what the client sends is exactly what the server accepts', () => {
  const query = buildActivityLogQuery({ fromDate: new Date('2026-10-16T00:00:00.000Z'), toDate: new Date('2026-10-16T15:59:59.999Z') })
  const sent = Object.fromEntries(new URLSearchParams(query))
  assert.deepEqual(parseActivityLogRange(sent), { fromISO: '2026-10-16T00:00:00.000Z', toISO: '2026-10-16T15:59:59.999Z' })
})

// The Audit page filters every consumer by its own exact range; this window
// only has to be wide enough to contain both ranges.
const T = (iso) => new Date(iso).getTime()
const PAD = AUDIT_LOG_WINDOW_PADDING_MS

test('Audit fetches the union of its two ranges, padded for the 60s fallback-log matching', () => {
  const win = computeAuditLogWindow({
    fromTime: T('2026-10-16T16:00:00.000Z'), toTime: T('2026-10-17T15:59:59.999Z'),     // summary: one day
    logFromTime: T('2026-10-10T16:00:00.000Z'), logToTime: T('2026-10-16T15:59:59.999Z'), // logs tab: a week
  })
  assert.equal(win.from, new Date(T('2026-10-10T16:00:00.000Z') - PAD).toISOString())
  assert.equal(win.to, new Date(T('2026-10-17T15:59:59.999Z') + PAD).toISOString())
})

test('Audit with identical ranges (the default: today / today) fetches just that day plus padding', () => {
  const day = { fromTime: T('2026-10-16T16:00:00.000Z'), toTime: T('2026-10-17T15:59:59.999Z') }
  const win = computeAuditLogWindow({ ...day, logFromTime: day.fromTime, logToTime: day.toTime })
  assert.equal(win.from, new Date(day.fromTime - PAD).toISOString())
  assert.equal(win.to, new Date(day.toTime + PAD).toISOString())
})

test('Audit leaves an end open whenever EITHER range is open there, so data is never narrower than the page filters on', () => {
  const closed = { fromTime: T('2026-10-16T16:00:00.000Z'), toTime: T('2026-10-17T15:59:59.999Z') }
  // "All dates" on the summary: open both ends
  assert.deepEqual(computeAuditLogWindow({ fromTime: null, toTime: null, logFromTime: closed.fromTime, logToTime: closed.toTime }), { from: '', to: '' })
  // "All dates" on the logs tab only
  assert.deepEqual(computeAuditLogWindow({ ...closed, logFromTime: null, logToTime: null }), { from: '', to: '' })
  // a custom range with only a start: open end, closed start
  const half = computeAuditLogWindow({ fromTime: closed.fromTime, toTime: null, logFromTime: closed.fromTime, logToTime: closed.toTime })
  assert.equal(half.to, '')
  assert.equal(half.from, new Date(closed.fromTime - PAD).toISOString())
  // an unreadable (NaN) bound is treated as open, never as an invalid-date crash
  assert.deepEqual(computeAuditLogWindow({ fromTime: NaN, toTime: NaN, logFromTime: NaN, logToTime: NaN }), { from: '', to: '' })
})
