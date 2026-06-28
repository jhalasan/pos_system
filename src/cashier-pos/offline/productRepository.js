import { cashierDb } from './db'

function firstFileValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function normalizeProduct(record, pb) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category
  const image = firstFileValue(record.product_img ?? record.image)

  return {
    id: record.id,
    barcode: String(record.barcode || '').trim(),
    name: String(record.name || ''),
    category: category?.name || '',
    categoryId: Array.isArray(record.category) ? record.category[0] : record.category || '',
    quantity: Number(record.quantity) || 0,
    price: Number(record.price) || 0,
    unit: record.base_unit || 'Piece',
    minStock: Number(record.min_stock) || 0,
    image: image || '',
    imageUrl: record.imageUrl || (pb && image ? pb.files.getURL(record, image) : ''),
    updated: record.updated || new Date().toISOString(),
  }
}

export async function replaceProductsFromCloud(records, pb) {
  const products = records.map((record) => normalizeProduct(record, pb))

  await cashierDb.transaction('rw', cashierDb.products, async () => {
    await cashierDb.products.clear()
    await cashierDb.products.bulkPut(products)
  })

  return products
}

export function getAllProducts() {
  return cashierDb.products
    .toArray()
    .then((products) => products.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))))
}

export async function getProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return undefined
  return cashierDb.products
    .filter((product) => String(product.barcode || '').trim() === normalizedBarcode)
    .first()
}

export function searchProducts(query, limit = 50) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase()
  if (!normalizedQuery) return getAllProducts().then((products) => products.slice(0, limit))

  return cashierDb.products
    .filter((product) => (
      product.name.toLocaleLowerCase().includes(normalizedQuery)
      || product.barcode.includes(normalizedQuery)
    ))
    .limit(limit)
    .toArray()
}

