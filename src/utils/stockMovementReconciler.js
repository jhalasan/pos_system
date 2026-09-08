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

// T3 (request-volume half): a multi-line sale used to call findStockMovement
// once per line -- N requests just to learn which lines (usually none, on a
// first attempt) were already deducted by an earlier, interrupted upload
// attempt. reference_id values are already unique per line (they embed the
// sale's clientSaleId and the line's own lineId/productId), so a single
// query for "any movement whose reference_id is one of these" replaces all
// of them. Returns a Map keyed by reference_id for O(1) lookup by callers.
//
// Deliberately does NOT swallow a request failure into "found nothing" --
// see findStockMovement's own comment above for why: a 429/5xx/network blip
// here must propagate so the caller's existing per-op retry/backoff runs
// again, instead of silently treating an unknown state as "not yet
// deducted," which is exactly what would cause a double deduction on retry.
export async function findExistingStockMovementsByReference(pb, referenceIds = []) {
  const uniqueReferenceIds = [...new Set(referenceIds.filter(Boolean))]
  if (!uniqueReferenceIds.length) return new Map()

  const filter = uniqueReferenceIds
    .map((referenceId) => pb.filter('reference_id = {:referenceId}', { referenceId }))
    .join(' || ')

  // getList (not getFullList) to match the bounded-read convention already
  // established by reconcileProductStock above -- a single sale never has
  // more lines than this page size, so one page is always enough.
  const { items: movements } = await pb.collection('stock_movements').getList(1, 200, {
    filter,
    requestKey: null,
  })

  return new Map(movements.map((movement) => [movement.reference_id, movement]))
}

// Movement deltas are summed in integer thousandths (millis) rather than as
// floating-point numbers. Fractional quantities (e.g. 0.1 + 0.2) do not sum
// exactly in floating point, and the reconcile step below compares the
// replayed total against the stored value with strict equality — any drift
// would make it write a "correction" on every single run.
//
// Prefers the movement's own recorded `quantity` (the actual magnitude that
// was scanned/typed for THIS event) + a sign from movement_type, over
// diffing previous_quantity/new_quantity. Root-caused from a live incident
// (WILKINS PURE 500ml CASE): a Stock In of 20 cases was applied while the
// product's true cloud quantity was ~204, but the op's own fresh read of
// product.quantity raced against nine other concurrent writes and landed on
// a stale snapshot, so its previous_quantity/new_quantity pair (0 -> 20) was
// simply wrong -- diffing it produced a wrong delta. `quantity` (20, times
// the unit conversion the cashier/admin actually selected) is immune to
// this: it's the intrinsic size of the event, unaffected by what any
// concurrent read of product.quantity happened to see. Only falls back to
// the previous/new diff when `quantity` is absent (defensive only -- every
// real movement always has one; kept for callers/tests that construct
// movements from previous/new snapshots alone).
function movementDeltaMillis(movement) {
  const rawQuantity = Number(movement.quantity)
  if (Number.isFinite(rawQuantity)) {
    const positive = ['stock_in', 'void_return', 'refund_return', 'exchange_return'].includes(movement.movement_type)
    const magnitudeMillis = Math.abs(toMillis(rawQuantity))
    return positive ? magnitudeMillis : -magnitudeMillis
  }
  const previous = Number(movement.previous_quantity)
  const next = Number(movement.new_quantity)
  if (Number.isFinite(previous) && Number.isFinite(next)) return toMillis(next) - toMillis(previous)
  return 0
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

// Cap on how many movements since the last Stock Count reconciliation will
// fetch in full. A product recounted at any reasonable cadence never gets
// close to this; it exists only so a product that has genuinely NEVER been
// counted (or not in a very long time) can't turn one reconcile call into an
// unbounded fetch of its entire lifetime history.
const MAX_MOVEMENTS_SINCE_ANCHOR = 1000

// Root-caused from a live incident (WILKINS PURE 500ml CASE, 2026-09-07): a
// Stock In of 20 cases was immediately wiped back down to (effectively) 0.
// The old algorithm anchored on whatever movement happened to be oldest in a
// fixed 50-item window and trusted ITS previous_quantity as the true
// baseline -- but for a high-velocity product, that window can be entirely
// made of movements from concurrent multi-terminal sales that all raced off
// the same stale read (confirmed live: nine separate movements for this one
// product all independently recorded previous_quantity=43, because nine
// terminal-side reads happened before any of their writes landed). None of
// those previous_quantity values reflect reality, so anchoring on one of
// them and diffing forward produced a number with no relationship to the
// truth -- in this incident, exactly 0.
//
// A Stock Count (or the one-time PocketHost-migration merge) is the one kind
// of movement whose previous_quantity/new_quantity pair is NOT subject to
// this race: it's an absolute declaration, written once, valid by
// definition at the moment it was made. Anchoring on the most recent one of
// those instead -- and summing every real movement's own recorded `quantity`
// (see movementDeltaMillis) since then -- means every number that goes into
// the total is either a trusted checkpoint or an intrinsic, race-proof
// magnitude. No previous_quantity/new_quantity chain is trusted at all.
async function findReconciliationAnchor(pb, productId) {
  return pb.collection('stock_movements').getFirstListItem(
    pb.filter('product_id = {:productId} && movement_type = "adjustment"', { productId }),
    { sort: '-created,-created_at', requestKey: null },
  ).catch((error) => {
    if (error?.status === 404) return null
    throw error
  })
}

export async function reconcileProductStock(pb, productId) {
  const anchor = await findReconciliationAnchor(pb, productId)

  let movements
  if (anchor) {
    const { items: sinceAnchorAscending } = await pb.collection('stock_movements').getList(1, MAX_MOVEMENTS_SINCE_ANCHOR, {
      filter: pb.filter('product_id = {:productId} && created > {:since}', { productId, since: anchor.created }),
      sort: 'created',
      requestKey: null,
    })
    if (sinceAnchorAscending.length >= MAX_MOVEMENTS_SINCE_ANCHOR) {
      // This product hasn't been counted in a very long time relative to its
      // sales velocity -- fetching the true remainder would be unbounded.
      // Fall back to the old windowed heuristic rather than either failing
      // or reading a product's entire history; flagged so it's visible this
      // product is overdue for a fresh physical count.
      console.warn('[stockMovementReconciler] product has too many movements since its last count to anchor on it safely -- falling back to the recent-window heuristic; this product should be recounted', { productId, anchorCreated: anchor.created })
    } else {
      // Synthetic leading entry: baseline = the count's own declared value,
      // contributing zero further delta itself (quantity: 0), so the
      // existing baseline-plus-delta-sum walk in stockQuantityFromMovements
      // needs no changes to consume it.
      movements = [
        { ...anchor, previous_quantity: anchor.new_quantity, quantity: 0 },
        ...sinceAnchorAscending,
      ]
    }
  }

  if (!movements) {
    // No Stock Count ever recorded (or the safety cap above was hit) --
    // Page 1 must be sorted DESCENDING (newest first). Page 1 of an
    // ASCENDING sort is the OLDEST page once a product has accumulated more
    // than WINDOW_SIZE lifetime movements -- that silently anchors every
    // reconciliation on a stale, frozen-in-time total and overwrites every
    // subsequent correct products.update() back to it. Fetch newest-first,
    // then reverse to the ascending order stockQuantityFromMovements expects
    // (movements[0] as the window's baseline anchor).
    const { items: recentDescending } = await pb.collection('stock_movements').getList(1, WINDOW_SIZE, {
      filter: pb.filter('product_id = {:productId}', { productId }),
      sort: '-created,-created_at',
      requestKey: null,
    })
    movements = recentDescending.slice().reverse()
  }

  const quantity = stockQuantityFromMovements(movements)
  if (quantity === null) return null
  const product = await pb.collection('products').getOne(productId, { requestKey: null })
  if (quantizeQty(product.quantity) !== quantity) {
    await pb.collection('products').update(productId, { quantity: String(quantity) }, { requestKey: `reconcile:${productId}:${movements.length}` })
  }
  return quantity
}
