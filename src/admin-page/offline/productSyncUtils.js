function matchesStockOp(op, cloudProduct, localProduct) {
  if (!['scanInventory', 'stockOutInventory'].includes(op?.type)) return false
  return op.productId === cloudProduct.id
    || op.productId === localProduct?.id
    || (cloudProduct.barcode && op.payload?.barcode === cloudProduct.barcode)
    || (localProduct?.barcode && op.payload?.barcode === localProduct.barcode)
}

function matchesFieldEditOp(op, cloudProduct, localProduct) {
  if (!['createProduct', 'updateProduct'].includes(op?.type)) return false
  return op.productId === cloudProduct.id || op.productId === localProduct?.id
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

  // A queued name/price/lifecycle/etc. edit that has not synced yet means
  // this cloud snapshot was fetched before that edit reached PocketBase --
  // it is stale for this product specifically, even though the fetch itself
  // just succeeded. Falling through to the qty-only "preserve local" branch
  // below would spread the stale cloudProduct first and only keep qty,
  // silently reverting every other field (name, price, lifecycle_status...)
  // back to its pre-edit value the moment any periodic catalog pull landed
  // while the edit was still in flight -- e.g. an Archive or Delete
  // appearing to "undo itself" seconds after being applied.
  if (pendingOps.some((op) => matchesFieldEditOp(op, cloudProduct, localProduct))) {
    return { ...localProduct, status: deriveStatus({ ...localProduct }) }
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
