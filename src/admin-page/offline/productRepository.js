import { adminDb } from './db'
import { mergeProductWithCloudRecord } from './productSyncUtils'

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

export function deriveStatus(product) {
  const qty = Number(product.qty ?? product.quantity) || 0
  const lowStock = Number(product.lowStock ?? product.min_stock ?? 10)
  if (qty <= 0) return 'out-of-stock'
  if (qty <= 5) return 'critical'
  if (qty <= lowStock) return 'low'
  return 'in-stock'
}

export function normalizeProduct(record, pb) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category
  const image = Array.isArray(record.product_img) ? record.product_img[0] : record.product_img
  const categoryName = category?.name || record.categoryName || record.category || ''

  return {
    id: record.id,
    sku: record.id,
    name: String(record.name || ''),
    barcode: String(record.barcode || '').trim(),
    category: categoryName,
    categoryId: firstRelation(record.category) || record.categoryId || '',
    qty: Number(record.quantity ?? record.qty) || 0,
    unit: record.base_unit || record.unit || 'Piece',
    purchaseUnit: record.purchase_unit || record.purchaseUnit || 'Box',
    conversionQuantity: Number(record.conversion_quantity ?? record.conversionQuantity ?? 1) || 1,
    initialStock: Number(record.initial_stock ?? record.initialStock ?? 0) || 0,
    stockUnit: record.stock_unit || record.stockUnit || '',
    lowStock: Number(record.min_stock ?? record.lowStock) || 0,
    price: Number(record.price) || 0,
    cost: Number(record.cost) || 0,
    profitMargin: Number(record.profitMargin) || 0,
    hasMultipleUnits: Boolean(record.has_multiple_units ?? record.hasMultipleUnits),
    image: image || record.image || '',
    imageUrl: record.imageUrl || (pb && image ? pb.files.getURL(record, image) : ''),
    imageBlob: record.imageBlob,
    imageName: record.imageName || '',
    tiers: record.tiers || [{ label: 'Retail', price: Number(record.price) || 0 }],
    sellingUnits: Array.isArray(record.selling_units ?? record.sellingUnits)
      ? record.selling_units ?? record.sellingUnits
      : (typeof (record.selling_units ?? record.sellingUnits) === 'string' ? JSON.parse((record.selling_units ?? record.sellingUnits) || '[]') : []),
    status: deriveStatus(record),
    pendingSync: Boolean(record.pendingSync),
    deleted: Boolean(record.deleted),
    updated: record.updated || new Date().toISOString(),
  }
}

function matchesStockOp(op, cloudProduct, localProduct) {
  if (!['scanInventory', 'stockOutInventory'].includes(op?.type)) return false
  return op.productId === cloudProduct.id
    || op.productId === localProduct?.id
    || (cloudProduct.barcode && op.payload?.barcode === cloudProduct.barcode)
    || (localProduct?.barcode && op.payload?.barcode === localProduct.barcode)
}

export async function replaceProductsFromCloud(records, pb) {
  const products = records.map((record) => normalizeProduct(record, pb))

  await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
    const localProducts = await adminDb.products.toArray()
    const pendingOps = await adminDb.pendingOps
      .filter((op) => ['pending', 'failed'].includes(op.status))
      .toArray()
    const localById = new Map(localProducts.map((product) => [product.id, product]))
    const localByBarcode = new Map(localProducts
      .filter((product) => product.barcode)
      .map((product) => [product.barcode, product]))
    const pendingLocalProducts = new Set()

    const mergedProducts = products.map((cloudProduct) => {
      const localProduct = localById.get(cloudProduct.id) || localByBarcode.get(cloudProduct.barcode)
      if (!localProduct) return cloudProduct
      if (localProduct.deleted) {
        pendingLocalProducts.add(localProduct.id)
        return mergeProductWithCloudRecord(cloudProduct, localProduct, pendingOps)
      }

      const merged = mergeProductWithCloudRecord(cloudProduct, localProduct, pendingOps, deriveStatus)
      if (localProduct.pendingSync || pendingOps.some((op) => matchesStockOp(op, cloudProduct, localProduct))) {
        pendingLocalProducts.add(localProduct.id)
      }
      return merged
    })

    const unmatchedPending = localProducts.filter((product) => (
      product.pendingSync
      && !product.deleted
      && !pendingLocalProducts.has(product.id)
      && !products.some((cloudProduct) => (
        cloudProduct.id === product.id || (cloudProduct.barcode && cloudProduct.barcode === product.barcode)
      ))
    ))

    await adminDb.products.clear()
    await adminDb.products.bulkPut([...mergedProducts, ...unmatchedPending])
  })

  return products
}

export async function replaceCategoriesFromCloud(records) {
  const categories = records.map((record) => ({
    id: record.id,
    name: String(record.name || ''),
    updated: record.updated || new Date().toISOString(),
  }))

  await adminDb.transaction('rw', adminDb.categories, async () => {
    await adminDb.categories.clear()
    await adminDb.categories.bulkPut(categories)
  })

  return categories
}

export function getAllProducts() {
  return adminDb.products
    .toArray()
    .then((products) => products
      .filter((product) => !product.deleted)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))))
}

export async function getProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return undefined
  const product = await adminDb.products
    .filter((product) => {
      if (String(product.barcode || '').trim() === normalizedBarcode) return true
      return Array.isArray(product.sellingUnits)
        && product.sellingUnits.some((unit) => String(unit?.barcode || '').trim() === normalizedBarcode)
    })
    .first()
  return product?.deleted ? undefined : product
}

export async function getLocalCategories() {
  return (await adminDb.categories.toArray())
    .map((category) => category.name)
    .sort((a, b) => String(a || '').localeCompare(String(b || '')))
}
