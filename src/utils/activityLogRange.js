// Shared by the Express /api/activity-logs route and its tests.
//
// activity_logs grows by roughly 900 rows a day, and the route used to return
// the whole collection on every call (about 60,000 rows / 13 MB by October
// 2026 -- far past Vercel's ~4.5 MB response limit, and minutes to read). Every
// reader now asks for the window it actually needs.

// Only the fields toActivityLog (server) and toCloudActivityLog (desktop)
// read. Without this, every log row also carries the whole expanded user
// record; verified against live data to give identical mapped output at
// roughly 40% of the raw size.
export const ACTIVITY_LOG_FIELDS = [
  'id',
  'action_type',
  'description',
  'timestamp',
  'created',
  'user_id',
  'expand.user_id.name',
  'expand.user_id.email',
  'expand.user_id.role',
].join(',')

function toISO(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ${label} date.`)
  return date.toISOString()
}

// Accepts ISO strings or Dates; an omitted side stays open-ended. A malformed
// date throws rather than being ignored, because ignoring it would silently
// fall back to returning every log.
export function parseActivityLogRange({ fromDate, toDate } = {}) {
  const fromISO = toISO(fromDate, 'from')
  const toISOValue = toISO(toDate, 'to')
  if (fromISO && toISOValue && fromISO > toISOValue) {
    throw new RangeError('The from date must not be after the to date.')
  }
  return { fromISO, toISO: toISOValue }
}

// Query string for GET /api/activity-logs: "" when unbounded, otherwise
// "?fromDate=<ISO>&toDate=<ISO>". Accepts Dates or date strings; a missing or
// unreadable side is left open (the server separately rejects a malformed one,
// but this client only ever sends instants it produced itself).
export function buildActivityLogQuery(range) {
  const { fromDate, toDate } = range || {}
  const params = new URLSearchParams()
  for (const [key, value] of [['fromDate', fromDate], ['toDate', toDate]]) {
    if (value === undefined || value === null || value === '') continue
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) params.set(key, date.toISOString())
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}
