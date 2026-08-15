// M9 (POS_AUDIT_REGISTER.md): the `products.lifecycle_status` field that the
// existing Archive button, and the delete-with-sale-history fallback added
// this session, both depend on does not actually exist on the live
// production PocketBase. It only ever existed in the local
// `pocketbase/pb_schema.json` reference file -- a snapshot that was never
// applied as a real migration. Confirmed directly against production via the
// PocketBase JS SDK: `products.fields.find(f => f.name === 'lifecycle_status')`
// returns undefined. Every write that sets `lifecycle_status: 'archived'`
// against this field name has always been silently accepted by PocketBase
// (unknown fields on an update are simply ignored, not rejected) and done
// nothing at all -- which is why Archive has never actually worked in
// production, and why this session's delete-fallback fix appeared to do
// nothing too.
//
// This is an ADDITIVE-ONLY migration: no existing field or record is
// touched. Every product implicitly defaults to 'active' behavior in the app
// code already (every read site treats a missing lifecycle_status as
// 'active'), so adding this field changes nothing for existing products
// until an admin explicitly archives one.
//
//   node scripts/add-product-lifecycle-schema.mjs

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

function fieldsKeyOf(collection) {
  return Array.isArray(collection.fields) ? 'fields' : 'schema'
}

async function ensureField(collectionName, field) {
  const collection = await pb.collections.getOne(collectionName)
  const fieldsKey = fieldsKeyOf(collection)
  const fields = collection[fieldsKey] || []
  if (fields.some((existing) => existing.name === field.name)) {
    console.log(`${collectionName}.${field.name}: already exists, skipping`)
    return
  }
  await pb.collections.update(collection.id, { [fieldsKey]: [...fields, field] })
  console.log(`${collectionName}.${field.name}: field created`)
}

await authAsSuperuser()

await ensureField('products', {
  name: 'lifecycle_status',
  type: 'select',
  required: false,
  maxSelect: 1,
  values: ['active', 'inactive', 'archived'],
  help: 'Controls whether the product appears in active selling and inventory lists. Missing/absent means active.',
})

console.log('Product lifecycle schema migration complete.')
