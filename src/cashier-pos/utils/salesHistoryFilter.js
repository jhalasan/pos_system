// PocketBase filter/param builder for the cashier "Recent Transactions"
// history list. Extracted into its own pure module (no PocketBase SDK or
// import.meta.env dependency) so it's directly unit-testable, and shared
// between the `sales` query and the `sale_items` query in desktopApi.js's
// cloudSalesHistory. Mirrors the existing date-range filter precedent in
// src/admin-page/services/cloud.js's fetchSalesReport.
//
// dateField defaults to `sales`' own business timestamp (`created_at`);
// `sale_items` has no such field and must pass `dateField: 'created'` (its
// PocketBase system autodate field) instead.
export function buildSalesHistoryFilter({ cashierId, fromISO, toISO, dateField = 'created_at' } = {}) {
  const clauses = []
  const params = {}
  if (cashierId) {
    clauses.push('cashier_id = {:cashierId}')
    params.cashierId = cashierId
  }
  if (fromISO) {
    clauses.push(`${dateField} >= {:from}`)
    params.from = fromISO
  }
  if (toISO) {
    clauses.push(`${dateField} <= {:to}`)
    params.to = toISO
  }
  return { filter: clauses.join(' && '), params }
}
