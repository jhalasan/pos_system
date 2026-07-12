function movementDelta(movement) {
  const previous = Number(movement.previous_quantity)
  const next = Number(movement.new_quantity)
  if (Number.isFinite(previous) && Number.isFinite(next)) return next - previous
  const quantity = Math.abs(Number(movement.quantity) || 0)
  return ['stock_in', 'void_return', 'refund_return', 'exchange_return'].includes(movement.movement_type)
    ? quantity
    : -quantity
}

export async function findStockMovement(pb, productId, referenceId) {
  return pb.collection('stock_movements').getFirstListItem(
    pb.filter('product_id = {:productId} && reference_id = {:referenceId}', { productId, referenceId }),
    { requestKey: null },
  ).catch(() => null)
}

export function stockQuantityFromMovements(movements = []) {
  if (!movements.length) return null
  const baseline = Number(movements[0].previous_quantity) || 0
  return Math.max(0, movements.reduce((total, movement) => total + movementDelta(movement), baseline))
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
  if ((Number(product.quantity) || 0) !== quantity) {
    await pb.collection('products').update(productId, { quantity: String(quantity) }, { requestKey: `reconcile:${productId}:${movements.length}` })
  }
  return quantity
}
