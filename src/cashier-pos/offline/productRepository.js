import { cashierDb } from './db'

function normalizeProduct(record) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category

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
    updated: record.updated || new Date().toISOString(),
  }
}

export async function replaceProductsFromCloud(records) {
  const products = records.map(normalizeProduct)

  await cashierDb.transaction('rw', cashierDb.products, async () => {
    await cashierDb.products.clear()
    await cashierDb.products.bulkPut(products)
  })

  return products
}

export function getAllProducts() {
  return cashierDb.products.orderBy('name').toArray()
}

export async function getProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return undefined
  return cashierDb.products.get({ barcode: normalizedBarcode })
}

export function searchProducts(query, limit = 50) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase()
  if (!normalizedQuery) return cashierDb.products.orderBy('name').limit(limit).toArray()

  return cashierDb.products
    .filter((product) => (
      product.name.toLocaleLowerCase().includes(normalizedQuery)
      || product.barcode.includes(normalizedQuery)
    ))
    .limit(limit)
    .toArray()
}

