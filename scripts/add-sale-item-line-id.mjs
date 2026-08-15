// T3 (partial): two cart lines of the SAME product (e.g. one sold as a
// case, one sold loose, at different prices) used to collapse into a single
// productId-keyed stock-movement reference in
// src/cashier-pos/offline/syncEngine.js's ensureCloudStockDeduction:
// creating the movement for line 1 made findStockMovement report "already
// deducted" for line 2, silently skipping its stock deduction.
//
// This adds sale_items.line_id (additive only) so each cart line gets its
// own durable identity to key the stock-movement reference on. The value is
// the same lineId the cashier terminal already mints locally per line
// (saleRepository.js's finalizeSaleLocally).
//
//   node scripts/add-sale-item-line-id.mjs
//
// Written and reviewed but NOT executed against a live PocketBase from this
// session -- see POS_AUDIT_REGISTER.md, T3.

import 'dotenv/config'
import PocketBase from 'pocketbase'

const pbUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD

if (!email || !password) {
  throw new Error('Set POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in .env first.')
}

const pb = new PocketBase(pbUrl)
pb.autoCancellation(false)

async function authAsSuperuser() {
  try {
    await pb.collection('_superusers').authWithPassword(email, password)
  } catch (error) {
    if (error.status !== 404) throw error
    await pb.collection('_admins').authWithPassword(email, password)
  }
}

await authAsSuperuser()

const collection = await pb.collections.getOne('sale_items')
const fieldsKey = Array.isArray(collection.fields) ? 'fields' : 'schema'
const fields = collection[fieldsKey] || []

if (fields.some((field) => field.name === 'line_id')) {
  console.log('sale_items.line_id: already exists, skipping')
} else {
  await pb.collections.update(collection.id, {
    [fieldsKey]: [...fields, {
      name: 'line_id',
      type: 'text',
      required: false,
      help: 'Stable per-cart-line identity minted by the cashier terminal. Distinct from product_id -- two lines of the same product get different line_id values, so each gets its own stock-movement reference.',
    }],
  })
  console.log('sale_items.line_id: field created')
}

console.log('sale_items.line_id migration complete.')
