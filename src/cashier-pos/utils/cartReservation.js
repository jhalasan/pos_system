import { toBaseStockQuantity } from '../offline/stockUtils'

// The cashier UI supports multiple simultaneous held-sale tabs on one
// terminal (see Cashier.jsx's transaction tabs). To stop one tab from
// overselling stock another tab already has in its cart, add-to-cart checks
// subtract every OTHER open tab's cart quantity of the same product from
// real stock before deciding what's available. This is the pure aggregation
// behind that check, extracted so it's testable without a component harness
// and so add-to-cart error messages can explain *why* a block happened
// (which tab is holding the reservation) instead of just saying "out of
// stock" when the product tile the cashier is looking at shows plenty.
export function reservedQuantityDetail(transactions, productId, { excludedTransactionId = null, excludedCartItemId = null } = {}) {
  const normalizedProductId = String(productId || '')
  let reservedBaseQty = 0
  const holdingTransactions = []

  for (const txn of Array.isArray(transactions) ? transactions : []) {
    if (!txn || txn.id === excludedTransactionId) continue
    if (txn.status === 'completed' || txn.status === 'voided') continue

    let txnReserved = 0
    for (const cartItem of Array.isArray(txn.cartItems) ? txn.cartItems : []) {
      const itemProductId = String(cartItem.productId || cartItem.id || '')
      if (itemProductId !== normalizedProductId || !itemProductId) continue
      const itemId = String(cartItem.id || '')
      if (excludedCartItemId && itemId === excludedCartItemId) continue
      txnReserved += toBaseStockQuantity(cartItem.quantity, cartItem.conversion)
    }

    if (txnReserved > 0) {
      reservedBaseQty += txnReserved
      holdingTransactions.push({ id: txn.id, name: txn.name || `Transaction ${txn.id}`, baseQty: txnReserved })
    }
  }

  return { reservedBaseQty, holdingTransactions }
}
