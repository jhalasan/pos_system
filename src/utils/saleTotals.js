// Pure helpers for netting refunds out of revenue/units-sold reporting.
// A refund never mutates a sale's stored total_amount/units -- those are
// the historical facts of the original transaction. Reporting reads must
// net the refunded amount/units out separately, via these helpers, so a
// dashboard or FSN report reflects what the business actually kept.
//
// Locked-in decision (do not change without the client): refunds net out of
// BOTH revenue and units-sold/FSN analytics, not revenue alone. See
// POS_AUDIT_REGISTER.md.
//
// A legacy sale row with no refunded_amount/refunded_units at all (every row
// created before this fields existed) must report its full original total
// and units, completely unchanged -- these helpers treat a missing field the
// same as zero refunded, which is exactly that behavior, not a special case.

function numberOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

// Accepts either the admin-side camelCase shape (totalAmount, refundedAmount)
// or the raw PocketBase snake_case record (total_amount, refunded_amount) --
// callers in this codebase use both depending on whether the record has
// already passed through a formatter.
export function netSaleAmount(sale = {}) {
  const total = numberOrZero(sale.totalAmount ?? sale.total_amount)
  const refunded = numberOrZero(sale.refundedAmount ?? sale.refunded_amount)
  return Math.max(0, total - refunded)
}

export function netSaleUnits(sale = {}) {
  const items = Array.isArray(sale.items) ? sale.items : []
  const total = items.reduce((sum, item) => sum + numberOrZero(item.quantity ?? item.quantity_sold), 0)
  const refunded = numberOrZero(sale.refundedUnits ?? sale.refunded_units)
  return Math.max(0, total - refunded)
}
