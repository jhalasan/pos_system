import { adminDb } from './db'

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

export function deriveStatus(product) {
  const qty = Number(product.qty ?? product.quantity) || 0
  const lowStock = Number(product.lowStock ?? product.min_stock ?? 10)
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
    lowStock: Number(record.min_stock ?? record.lowStock) || 0,
    price: Number(record.price) || 0,
    image: image || record.image || '',
    imageUrl: record.imageUrl || (pb && image ? pb.files.getURL(record, image) : ''),
    imageBlob: record.imageBlob,
    imageName: record.imageName || '',
    tiers: record.tiers || [{ label: 'Retail', price: Number(record.price) || 0 }],
    status: deriveStatus(record),
    pendingSync: Boolean(record.pendingSync),
    deleted: Boolean(record.deleted),
    updated: record.updated || new Date().toISOString(),
  }
}

export async function replaceProductsFromCloud(records, pb) {
  const products = records.map((record) => normalizeProduct(record, pb))

  await adminDb.transaction('rw', adminDb.products, async () => {
    const pending = await adminDb.products.where('pendingSync').equals(true).toArray()
    await adminDb.products.clear()
    await adminDb.products.bulkPut(products)
    if (pending.length) await adminDb.products.bulkPut(pending)
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
    .filter((product) => !product.deleted)
    .sortBy('name')
}

export async function getProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return undefined
  const product = await adminDb.products.get({ barcode: normalizedBarcode })
  return product?.deleted ? undefined : product
}

export async function getLocalCategories() {
  return (await adminDb.categories.orderBy('name').toArray()).map((category) => category.name)
}
