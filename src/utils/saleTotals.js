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

function firstRelationValue(value) {
  return Array.isArray(value) ? value[0] : value
}

// sale_adjustments.items carries the same {productId, quantity, ...} shape
// queued locally by the cashier terminal (quantity is selling units, the
// same unit as sale_items.quantity_sold). Netting happens at the (sale,
// product) level, not per cart line: FSN/topProducts metrics are already
// aggregated per product, so there is nothing to gain from attributing a
// refund to one specific line over another of the same product in the same
// sale. Shared between server/index.js (the web admin's Express routes) and
// src/admin-page/services/desktopApi.js (the Tauri admin app's own,
// independent dashboard/FSN builders) so both surfaces net refunds the same
// way -- see POS_AUDIT_REGISTER.md M1.
export function refundedUnitsBySaleAndProduct(adjustments = []) {
  const map = new Map()
  for (const adjustment of adjustments) {
    const saleId = firstRelationValue(adjustment.sale_id ?? adjustment.saleId)
    if (!saleId) continue
    const items = Array.isArray(adjustment.items) ? adjustment.items : []
    for (const item of items) {
      const productId = String(item.productId || item.id || '')
      if (!productId) continue
      const key = `${saleId}:${productId}`
      map.set(key, (map.get(key) || 0) + (Number(item.quantity) || 0))
    }
  }
  return map
}
