// Inventory's "Total Products" stat and Dashboard's stock-related stats
// (critical alerts, current stock units, in-stock/low/critical/out-of-stock
// breakdown) used to count every product Dexie/PocketBase had a row for,
// including ones marked archived or deleted (see M9 in POS_AUDIT_REGISTER.md
// for how a product ends up in that state instead of being hard-deleted).
// An archived or deleted product isn't part of the sellable catalog anymore,
// so it shouldn't inflate "how many products do I stock" or trigger a
// restock alert for stock it will never sell again.
//
// Deliberately narrow: only 'archived' and 'deleted' are excluded.
// 'inactive' still counts -- that status means temporarily disabled, not
// removed, and sales-history lookups (resolving a past sale's product name,
// FSN classification) must keep using the *unfiltered* product list, since a
// product sold before being archived still needs to resolve correctly in
// historical reports.
const HIDDEN_CATALOG_LIFECYCLE_STATUSES = new Set(['archived', 'deleted'])

export function isCatalogActive(product) {
  const status = product?.lifecycleStatus || product?.lifecycle_status || 'active'
  return !HIDDEN_CATALOG_LIFECYCLE_STATUSES.has(status)
}
