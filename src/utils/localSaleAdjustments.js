// Bridges the gap between a cashier terminal's local, not-yet-synced sale
// records (Dexie-shaped: sale.adjustments[] inline on the sale) and the
// cloud's sale_adjustments collection (a separate collection, one row per
// adjustment), so both admin dashboards (Vercel web and the Tauri desktop
// app -- two independent implementations, see POS_AUDIT_REGISTER.md M1) can
// net refunds out of revenue/units-sold figures regardless of whether a
// given sale has synced yet.

// A cloud sale carries refunded_amount/refunded_units directly (M1's schema
// migration, written by syncEngine.js on each synced refund); a local,
// not-yet-synced sale only has its inline adjustments[] array. Computes the
// equivalent totals so a caller can attach them to a local-sale-as-cloud-like
// object and treat every sale uniformly afterward.
export function refundedAmountAndUnits(adjustments = []) {
  const list = Array.isArray(adjustments) ? adjustments : []
  const refundedAmount = list.reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0)
  const refundedUnits = list.reduce((sum, adjustment) => (
    sum + (Array.isArray(adjustment.items) ? adjustment.items : []).reduce(
      (itemSum, item) => itemSum + (Number(item.quantity) || 0),
      0,
    )
  ), 0)
  return { refundedAmount, refundedUnits }
}

// An adjustment already recorded in the cloud must not also be counted from
// a terminal's local copy of the same sale, or a refund gets netted twice.
// adjustment_id is the idempotency anchor shared by both -- see
// server/index.js's M1 migration and syncEngine.js's adjustCompletedSale
// handling; it is the same UUID the terminal already generates locally.
// Returns cloud-shaped {sale_id, items} entries for whatever hasn't synced
// yet, ready to merge alongside a real cloud sale_adjustments list.
export function localAdjustmentsNotYetSynced(localSales, cloudAdjustments = []) {
  const syncedIds = new Set(
    (Array.isArray(cloudAdjustments) ? cloudAdjustments : [])
      .map((entry) => String(entry?.adjustment_id || ''))
      .filter(Boolean),
  )
  return (Array.isArray(localSales) ? localSales : []).flatMap((sale) => {
    const saleId = sale?.clientSaleId || sale?.id || sale?.transactionNo
    return (Array.isArray(sale?.adjustments) ? sale.adjustments : [])
      .filter((adjustment) => !syncedIds.has(String(adjustment?.id || '')))
      .map((adjustment) => ({ sale_id: saleId, items: adjustment.items || [] }))
  })
}
