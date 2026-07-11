function stockDeltaForOp(op) {
  const qty = Math.max(0, Number(op?.payload?.qty) || 0)
  if (op?.type === 'scanInventory') return qty
  if (op?.type === 'stockOutInventory') return -qty
  return 0
}

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
  const stockDelta = stockOps.reduce((sum, op) => sum + stockDeltaForOp(op), 0)
  const shouldPreserveLocal = localProduct?.pendingSync || stockOps.length > 0
  if (!shouldPreserveLocal) return cloudProduct

  const fallbackQty = Number(localProduct?.qty ?? localProduct?.quantity ?? cloudProduct?.qty ?? cloudProduct?.quantity) || 0
  const baseQty = localProduct?.pendingSync || stockOps.length > 0
    ? fallbackQty
    : Number(cloudProduct?.qty ?? cloudProduct?.quantity) || 0
  const qty = stockOps.length > 0
    ? Math.max(0, baseQty + stockDelta)
    : Math.max(0, baseQty)
  return {
    ...cloudProduct,
    qty,
    pendingSync: true,
    status: deriveStatus({ ...cloudProduct, qty }),
  }
}
