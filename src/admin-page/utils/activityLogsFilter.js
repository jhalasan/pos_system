// PocketBase filter/param builder for the Activity Logs screen. Extracted
// into its own pure module (no PocketBase SDK or import.meta.env dependency)
// so it's directly unit-testable, mirroring the existing precedent in
// cashier-pos/utils/salesHistoryFilter.js.
//
// activity_logs' own business timestamp field is `timestamp` (set explicitly
// by every caller -- see cashier-pos/offline/syncEngine.js's uploadSale and
// admin-page/services/desktopApi.js's createCloudActivityLog), not the
// PocketBase system `created` field.
export function buildActivityLogsFilter({ fromISO, toISO } = {}) {
  const clauses = []
  const params = {}
  if (fromISO) {
    clauses.push('timestamp >= {:from}')
    params.from = fromISO
  }
  if (toISO) {
    clauses.push('timestamp <= {:to}')
    params.to = toISO
  }
  return { filter: clauses.join(' && '), params }
}
