import { toMillis, fromMillis, quantizeQty } from './quantity.js'

// Reconciliation reads only a bounded, recent window of movements rather than
// a product's entire lifetime — this is the single biggest remaining
// PocketBase request-volume amplifier in the codebase. Delta-summation
// (below) only needs the window's first previous_quantity as an anchor, so a
// recent window is sufficient to produce the correct net total.
const WINDOW_SIZE = 50

export async function findStockMovement(pb, productId, referenceId) {
  try {
    return await pb.collection('stock_movements').getFirstListItem(
      pb.filter('product_id = {:productId} && reference_id = {:referenceId}', { productId, referenceId }),
      { requestKey: null },
    )
  } catch (error) {
    // A genuine 404 ("no matching record") is the only failure that means
    // "no movement exists yet." Any other error — 429, 5xx, network blip —
    // must propagate so the caller's existing per-op Dexie backoff retries
    // the operation, instead of silently proceeding as if the movement were
    // unclaimed (which is exactly what causes stock double-deduction on
    // retry).
    if (error?.status === 404) return null
    throw error
  }
}

// Movement deltas are summed in integer thousandths (millis) rather than as
// floating-point numbers. Fractional quantities (e.g. 0.1 + 0.2) do not sum
// exactly in floating point, and the reconcile step below compares the
// replayed total against the stored value with strict equality — any drift
// would make it write a "correction" on every single run.
function movementDeltaMillis(movement) {
  const previous = Number(movement.previous_quantity)
  const next = Number(movement.new_quantity)
  if (Number.isFinite(previous) && Number.isFinite(next)) return toMillis(next) - toMillis(previous)
  const quantityMillis = Math.abs(toMillis(Number(movement.quantity) || 0))
  return ['stock_in', 'void_return', 'refund_return', 'exchange_return'].includes(movement.movement_type)
    ? quantityMillis
    : -quantityMillis
}

// Walks movements (oldest-first, per the existing contract) and checks
// whether the chain is contiguous: movement i's previous_quantity should
// equal movement i-1's new_quantity, compared as exact integer millis (not
// floats) for the same reason movementDeltaMillis is millis-based —
// floating point sums of fractional quantities drift.
//
// A mismatch here is NON-BLOCKING and purely diagnostic (logged via
// console.warn) — it does NOT short-circuit to null. Two different real
// situations produce the same mismatch signature and this function cannot
// tell them apart: (a) a genuine gap, a movement actually missing from the
// ledger (rare), and (b) two terminals writing legitimate concurrent
// movements off the same shared baseline (normal and frequent — e.g. both
// read quantity 20, and independently write {previous_quantity: 20,
// new_quantity: 18} and {previous_quantity: 20, new_quantity: 17}; neither
// chains onto the other, but both are valid deductions that must both
// count). Declining to reconcile (returning null) on every mismatch would
// leave whichever racy products.update the call sites already issued before
// invoking this reconciler as the permanent, only-half-correct value, with
// nothing to ever retry or self-heal it — worse than always summing, since
// delta-summation is invariant to write order and concurrency and always
// equals the true net change as long as no movement is truly missing.
export function stockQuantityFromMovements(movements = []) {
  if (!movements.length) return null

  for (let i = 1; i < movements.length; i += 1) {
    const expectedMillis = toMillis(Number(movements[i - 1].new_quantity) || 0)
    const foundMillis = toMillis(Number(movements[i].previous_quantity) || 0)
    if (expectedMillis !== foundMillis) {
      console.warn('[stockMovementReconciler] movement chain mismatch (informational only — the summed total below is still applied)', {
        productId: movements[i].product_id ?? movements[i - 1].product_id ?? null,
        previousIndex: i - 1,
        previousMovementId: movements[i - 1].id ?? null,
        mismatchedIndex: i,
        mismatchedMovementId: movements[i].id ?? null,
        expectedPreviousQuantityMillis: expectedMillis,
        foundPreviousQuantityMillis: foundMillis,
      })
    }
  }

  const baselineMillis = toMillis(Number(movements[0].previous_quantity) || 0)
  const totalMillis = movements.reduce((total, movement) => total + movementDeltaMillis(movement), baselineMillis)
  return Math.max(0, fromMillis(totalMillis))
}

export async function reconcileProductStock(pb, productId) {
  const { items: movements } = await pb.collection('stock_movements').getList(1, WINDOW_SIZE, {
    filter: pb.filter('product_id = {:productId}', { productId }),
    sort: 'created,created_at',
    requestKey: null,
  })
  const quantity = stockQuantityFromMovements(movements)
  if (quantity === null) return null
  const product = await pb.collection('products').getOne(productId, { requestKey: null })
  if (quantizeQty(product.quantity) !== quantity) {
    await pb.collection('products').update(productId, { quantity: String(quantity) }, { requestKey: `reconcile:${productId}:${movements.length}` })
  }
  return quantity
}
