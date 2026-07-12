import { cashierDb } from './db'
import { barcodesMatch, normalizeBarcode } from '../utils/barcodeUtils'

function firstFileValue(value) {
  return Array.isArray(value) ? value[0] : value
}

export function normalizeProduct(record, pb) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category
  const image = firstFileValue(record.product_img ?? record.image)
  const rawSellingUnits = record.selling_units ?? record.sellingUnits
  const sellingUnits = Array.isArray(rawSellingUnits)
    ? rawSellingUnits
    : (typeof rawSellingUnits === 'string' ? JSON.parse(rawSellingUnits || '[]') : [])

  return {
    id: record.id,
    barcode: String(record.barcode || '').trim(),
    name: String(record.name || ''),
    category: category?.name || record.categoryName || record.category || '',
    categoryId: Array.isArray(record.category) ? record.category[0] : record.category || '',
    quantity: Number(record.quantity ?? record.qty) || 0,
    price: Number(record.price) || 0,
    unit: record.base_unit || record.unit || 'Piece',
    minStock: Number(record.min_stock ?? record.minStock ?? record.lowStock) || 0,
    sellingUnits: sellingUnits.map((unit) => ({
      barcode: String(unit?.barcode || '').trim(),
      unit: String(unit?.unit || '').trim(),
      conversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
      price: Number(unit?.price) || 0,
    })).filter((unit) => unit.barcode || unit.unit || unit.conversion || unit.price),
    image: image || '',
    imageUrl: record.imageUrl || (pb && image ? pb.files.getURL(record, image) : ''),
    updated: record.updated || new Date().toISOString(),
  }
}

export async function replaceProductsFromCloud(records, pb) {
  const products = records.map((record) => normalizeProduct(record, pb))

  await cashierDb.transaction('rw', cashierDb.products, cashierDb.pendingSales, async () => {
    const pendingSales = await cashierDb.pendingSales.toArray()
    const pendingDeductions = new Map()
    for (const sale of pendingSales) {
      for (const item of sale.items || []) {
        const productId = String(item.productId || '')
        if (!productId) continue
        const baseQuantity = (Number(item.quantity) || 0) * (Number(item.conversion) > 0 ? Number(item.conversion) : 1)
        pendingDeductions.set(productId, (pendingDeductions.get(productId) || 0) + baseQuantity)
      }
    }
    const mergedProducts = products.map((product) => ({
      ...product,
      quantity: Math.max(0, product.quantity - (pendingDeductions.get(product.id) || 0)),
    }))
    await cashierDb.products.clear()
    await cashierDb.products.bulkPut(mergedProducts)
  })

  return products
}

export function getAllProducts() {
  return cashierDb.products
    .toArray()
    .then((products) => products.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))))
}

export async function getProductByBarcode(barcode) {
  const normalizedBarcode = normalizeBarcode(barcode)
  if (!normalizedBarcode) return undefined

  const baseProduct = await cashierDb.products
    .filter((product) => barcodesMatch(product.barcode, normalizedBarcode))
    .first()
  if (baseProduct) return baseProduct

  return cashierDb.products
    .filter((product) => Array.isArray(product.sellingUnits)
      ? product.sellingUnits.some((unit) => barcodesMatch(unit.barcode, normalizedBarcode))
      : false)
    .first()
}

export function searchProducts(query, limit = 50) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase()
  if (!normalizedQuery) return getAllProducts().then((products) => products.slice(0, limit))

  return cashierDb.products
    .filter((product) => {
      const productBarcode = normalizeBarcode(product.barcode || '').toLowerCase()
      return product.name.toLocaleLowerCase().includes(normalizedQuery)
      || productBarcode.includes(normalizedQuery)
      || (Array.isArray(product.sellingUnits)
        ? product.sellingUnits.some((unit) => (
          normalizeBarcode(String(unit?.barcode || '')).toLowerCase().includes(normalizedQuery)
          || String(unit?.unit || '').toLocaleLowerCase().includes(normalizedQuery)
        ))
        : false)
    })
    .limit(limit)
    .toArray()
}

