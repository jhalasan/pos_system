// The Audit page has two date ranges (the summary and the Audit Logs tab) that
// read the same activity logs, so it fetches the UNION of the two instead of
// the whole collection (~60,000 rows and growing). Every consumer on the page
// still filters by its own exact range, so this only has to be wide enough.
//
// An end that is open (an "All dates" range, or a custom range with one side
// empty) leaves that end of the fetch open too, so the fetched data is never
// narrower than what the page filters on. The window is padded slightly because
// the page matches locally stored fallback logs against cloud logs within 60
// seconds; a pair straddling a range edge must both be fetched.
export const AUDIT_LOG_WINDOW_PADDING_MS = 5 * 60 * 1000

export function computeAuditLogWindow({ fromTime, toTime, logFromTime, logToTime }, paddingMs = AUDIT_LOG_WINDOW_PADDING_MS) {
  const bothFinite = (a, b) => Number.isFinite(a) && Number.isFinite(b)
  return {
    from: bothFinite(fromTime, logFromTime) ? new Date(Math.min(fromTime, logFromTime) - paddingMs).toISOString() : '',
    to: bothFinite(toTime, logToTime) ? new Date(Math.max(toTime, logToTime) + paddingMs).toISOString() : '',
  }
}
