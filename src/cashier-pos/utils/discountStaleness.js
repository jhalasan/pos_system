// A peso discount is stored as the percent it worked out to against the
// subtotal at approval time (discountBaseSubtotal), not a standalone peso
// amount -- and the cart isn't locked until payment starts, so a cashier
// can still add/remove items after applying one. Left unguarded, that
// stale percentage would silently re-apply to a *different* subtotal
// (e.g. a ₱50-off-₱500 approval, stored as 10%, becomes ₱100 off if a
// ₱500 item is added afterward). A discount applied directly as a
// percentage has no such drift -- it's meant to scale with the cart --
// which is why discountBaseSubtotal is only ever set for peso mode
// (see Cashier.jsx's Apply Discount handler): a null baseline here means
// "not peso mode, nothing to compare" and this always returns false.
//
// Extracted as a pure function so the actual decision logic (not just the
// React effect wiring around it) has real test coverage.
export function shouldClearStaleDiscount({ isLockedTxn, discount, discountBaseSubtotal, subtotal }) {
  if (isLockedTxn) return false
  if (!(Number(discount) > 0)) return false
  if (discountBaseSubtotal == null) return false
  return Math.abs(Number(subtotal) - Number(discountBaseSubtotal)) >= 0.005
}
