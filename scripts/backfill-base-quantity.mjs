#!/usr/bin/env node
import { ensurePocketBaseAuth, pbCollection } from '../server/pocketbase.js'

async function parseSellingUnits(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

async function main() {
  console.log('Authenticating to PocketBase...')
  await ensurePocketBaseAuth()
  const saleItems = await pbCollection('sale_items')
  const products = await pbCollection('products')

  console.log('Fetching sale items...')
  const items = await saleItems.getFullList({ perPage: 200 }).catch(() => [])
  let updated = 0

  for (const item of items) {
    const hasBase = Number(item.base_quantity_sold) > 0
    if (hasBase) continue

    const quantitySold = Number(item.quantity_sold) || 0
    const productId = Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
    if (!productId) continue
    const product = await products.getOne(productId).catch(() => null)
    if (!product) continue

    const sellingUnits = parseSellingUnits(product.selling_units ?? product.sellingUnits)

    // Try to infer conversion from matching_unit_barcode or price
    let baseQuantity = 0
    let matchedBarcode = ''
    if (item.matching_unit_barcode) {
      const matched = sellingUnits.find((u) => String(u?.barcode || '').trim() === String(item.matching_unit_barcode || '').trim())
      if (matched) {
        const conv = Number(matched.conversion) > 0 ? Number(matched.conversion) : 1
        baseQuantity = quantitySold * conv
        matchedBarcode = String(matched.barcode || '').trim()
      }
    }

    if (!baseQuantity) {
      const matchedByPrice = sellingUnits.find((u) => Number(u?.price) && Number(u.price) === Number(item.price_at_sale))
      if (matchedByPrice) {
        const conv = Number(matchedByPrice.conversion) > 0 ? Number(matchedByPrice.conversion) : 1
        baseQuantity = quantitySold * conv
        matchedBarcode = String(matchedByPrice.barcode || '').trim()
      }
    }

    if (!baseQuantity) {
      // Last resort: assume quantity_sold is base units
      baseQuantity = quantitySold
    }

    try {
      await saleItems.update(item.id, {
        base_quantity_sold: baseQuantity,
        matching_unit_barcode: matchedBarcode || (item.matching_unit_barcode || ''),
      })
      updated += 1
    } catch (err) {
      console.warn('Failed to update sale_item', item.id, err.message)
    }
  }

  console.log(`Backfilled ${updated} sale_items with base quantities.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
