import { toMillis, fromMillis, quantizeQty } from './quantity.js'

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

export async function findStockMovement(pb, productId, referenceId) {
  return pb.collection('stock_movements').getFirstListItem(
    pb.filter('product_id = {:productId} && reference_id = {:referenceId}', { productId, referenceId }),
    { requestKey: null },
  ).catch(() => null)
}

export function stockQuantityFromMovements(movements = []) {
  if (!movements.length) return null
  const baselineMillis = toMillis(Number(movements[0].previous_quantity) || 0)
  const totalMillis = movements.reduce((total, movement) => total + movementDeltaMillis(movement), baselineMillis)
  return Math.max(0, fromMillis(totalMillis))
}

export async function reconcileProductStock(pb, productId) {
  const movements = await pb.collection('stock_movements').getFullList({
    filter: pb.filter('product_id = {:productId}', { productId }),
    sort: 'created_at,created',
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
