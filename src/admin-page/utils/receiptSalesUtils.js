function buildCategoryResolver(catalogCategories = [], catalogProducts = []) {
  const categoryNames = new Map()
  for (const category of catalogCategories || []) {
    const name = String(category?.name || category?.id || '').trim()
    if (!name) continue
    categoryNames.set(String(category.id || name), name)
    categoryNames.set(name, name)
  }
  const productsById = new Map()
  const productsByBarcode = new Map()
  const productsByName = new Map()
  for (const product of catalogProducts || []) {
    if (product.id) productsById.set(String(product.id), product)
    if (product.barcode) productsByBarcode.set(String(product.barcode), product)
    if (product.name) productsByName.set(String(product.name).toLowerCase(), product)
  }

  return function categoryForItem(item) {
    const raw = String(item.category || '').trim()
    if (categoryNames.has(raw)) return categoryNames.get(raw)
    const product = productsById.get(String(item.productId || ''))
      || productsByBarcode.get(String(item.barcode || item.matchingUnitBarcode || ''))
      || productsByName.get(String(item.name || '').toLowerCase())
    const productCategory = String(product?.category || product?.categoryId || '').trim()
    if (categoryNames.has(productCategory)) return categoryNames.get(productCategory)
    if (productCategory && !/^cat[a-z0-9]+$/i.test(productCategory)) return productCategory
    if (raw && !/^cat[a-z0-9]+$/i.test(raw)) return raw
    return 'Uncategorized (Legacy)'
  }
}

export function resolveReceiptCategories(receipts = [], catalogCategories = [], catalogProducts = []) {
  const categoryForItem = buildCategoryResolver(catalogCategories, catalogProducts)
  return (receipts || []).map((receipt) => ({
    ...receipt,
    items: (receipt.items || []).map((item) => ({ ...item, category: categoryForItem(item) })),
  }))
}

export function summarizeSalesByProduct(receipts = []) {
  const summary = new Map()
  for (const receipt of receipts || []) for (const item of receipt.items || []) {
    const key = `${item.category || 'Uncategorized'}|${item.name || 'Item'}`
    const current = summary.get(key) || { category: item.category || 'Uncategorized', product: item.name || 'Item', quantity: 0, revenue: 0 }
    current.quantity += Number(item.quantity) || 0
    current.revenue += (Number(item.quantity) || 0) * (Number(item.price) || 0)
    summary.set(key, current)
  }
  return [...summary.values()].sort((a, b) => b.revenue - a.revenue)
}

export function summarizeByCategory(productSummary = []) {
  const groups = productSummary.reduce((acc, row) => {
    const key = row.category
    acc[key] ||= { category: key, quantity: 0, revenue: 0 }
    acc[key].quantity += row.quantity
    acc[key].revenue += row.revenue
    return acc
  }, {})
  return Object.values(groups).sort((a, b) => b.revenue - a.revenue)
}

export function summarizeSalesByProductFiltered(receipts = [], { productFilter = 'all', categoryFilter = 'all' } = {}) {
  const summary = new Map()
  for (const receipt of receipts || []) for (const item of receipt.items || []) {
    if (productFilter !== 'all' && item.name !== productFilter) continue
    if (categoryFilter !== 'all' && item.category !== categoryFilter) continue
    const key = `${item.category || 'Uncategorized'}|${item.name || 'Item'}`
    const current = summary.get(key) || { category: item.category || 'Uncategorized', product: item.name || 'Item', quantity: 0, revenue: 0 }
    current.quantity += Number(item.quantity) || 0
    current.revenue += (Number(item.quantity) || 0) * (Number(item.price) || 0)
    summary.set(key, current)
  }
  return [...summary.values()].sort((a, b) => b.revenue - a.revenue)
}
