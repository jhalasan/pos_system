import { toMillis, fromMillis, quantizeQty } from './quantity.js'

// Reconciliation reads only a bounded, recent window of movements rather than
// a product's entire lifetime — this is the single biggest remaining
// PocketBase request-volume amplifier in the codebase, and a full-lifetime
// scan is unnecessary: chain validation below only needs a contiguous run of
// recent movements to produce a trustworthy answer.
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

// Walks movements (oldest-first, per the existing contract) and verifies the
// chain is contiguous: movement i's previous_quantity must equal movement
// i-1's new_quantity, compared as exact integer millis (not floats) for the
// same reason movementDeltaMillis used to — floating point sums of
// fractional quantities drift. Movement 0's previous_quantity is trusted as
// the anchor, exactly like before bounding the read window: for a
// never-bounded read that anchor is the product's true origin baseline;
// bounding the window only changes what "movement 0" means (from "ever" to
// "within the recent window"), not the trust model.
export function stockQuantityFromMovements(movements = []) {
  if (!movements.length) return null

  for (let i = 1; i < movements.length; i += 1) {
    const expectedMillis = toMillis(Number(movements[i - 1].new_quantity) || 0)
    const foundMillis = toMillis(Number(movements[i].previous_quantity) || 0)
    if (expectedMillis !== foundMillis) {
      console.warn('[stockMovementReconciler] broken movement chain', {
        productId: movements[i].product_id ?? movements[i - 1].product_id ?? null,
        previousIndex: i - 1,
        previousMovementId: movements[i - 1].id ?? null,
        mismatchedIndex: i,
        mismatchedMovementId: movements[i].id ?? null,
        expectedPreviousQuantityMillis: expectedMillis,
        foundPreviousQuantityMillis: foundMillis,
      })
      return null
    }
  }

  const last = movements[movements.length - 1]
  return Math.max(0, fromMillis(toMillis(last.new_quantity)))
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
