// PocketBase filter/param builder for the desktop admin Dashboard's `sales`
// query. Extracted into its own pure module (no PocketBase SDK or
// import.meta.env dependency) so it's directly unit-testable, mirroring
// activityLogsFilter.js and cashier-pos/utils/salesHistoryFilter.js.
import { toPocketBaseDate } from '../../utils/pocketBaseDate.js'

export function buildDashboardSalesFilter({ fromISO, toISO } = {}) {
  const clauses = []
  const params = {}
  if (fromISO) {
    clauses.push('created_at >= {:from}')
    params.from = toPocketBaseDate(fromISO)
  }
  if (toISO) {
    clauses.push('created_at <= {:to}')
    params.to = toPocketBaseDate(toISO)
  }
  return { filter: clauses.join(' && '), params }
}
