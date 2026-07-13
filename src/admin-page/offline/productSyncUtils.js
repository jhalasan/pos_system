function matchesStockOp(op, cloudProduct, localProduct) {
  if (!['scanInventory', 'stockOutInventory'].includes(op?.type)) return false
  return op.productId === cloudProduct.id
    || op.productId === localProduct?.id
    || (cloudProduct.barcode && op.payload?.barcode === cloudProduct.barcode)
    || (localProduct?.barcode && op.payload?.barcode === localProduct.barcode)
}

export function mergeProductWithCloudRecord(cloudProduct, localProduct, pendingOps = [], deriveStatus = () => 'in-stock') {
  if (localProduct?.deleted) {
    return {
      ...cloudProduct,
      deleted: true,
      pendingSync: true,
      status: deriveStatus({ ...cloudProduct, qty: Number(cloudProduct.qty ?? cloudProduct.quantity) || 0 }),
    }
  }

  const stockOps = pendingOps.filter((op) => matchesStockOp(op, cloudProduct, localProduct))
  const shouldPreserveLocal = localProduct?.pendingSync || stockOps.length > 0
  if (!shouldPreserveLocal) return cloudProduct

  const fallbackQty = Number(localProduct?.qty ?? localProduct?.quantity ?? cloudProduct?.qty ?? cloudProduct?.quantity) || 0
  // Inventory mutations update the local product and enqueue their operation in
  // one IndexedDB transaction. The local quantity therefore already includes
  // every pending delta and must not have those deltas applied a second time.
  const qty = Math.max(0, fallbackQty)
  return {
    ...cloudProduct,
    qty,
    pendingSync: true,
    status: deriveStatus({ ...cloudProduct, qty }),
  }
}
