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

const readRule = '@request.auth.role = "cashier" || @request.auth.role = "admin"'
const cashierRule = '@request.auth.role = "cashier" || @request.auth.role = "admin"'
const adminRule = '@request.auth.role = "admin"'

async function authAsSuperuser() {
  try {
    await pb.collection('_superusers').authWithPassword(email, password)
  } catch (error) {
    if (error.status !== 404) throw error
    await pb.collection('_admins').authWithPassword(email, password)
  }
}

async function updateCollection(name, rules) {
  const collection = await pb.collections.getOne(name)
  await pb.collections.update(collection.id, rules)
  console.log(`${name}: rules updated`)
}

async function patchField(name, fieldName, patch) {
  const collection = await pb.collections.getOne(name)
  const fieldsKey = Array.isArray(collection.fields) ? 'fields' : 'schema'
  const fields = collection[fieldsKey] || []
  const nextFields = fields.map((field) => (
    field.name === fieldName ? { ...field, ...patch } : field
  ))

  if (!fields.some((field) => field.name === fieldName)) {
    throw new Error(`${name}.${fieldName} was not found in PocketBase.`)
  }

  await pb.collections.update(collection.id, { [fieldsKey]: nextFields })
  console.log(`${name}.${fieldName}: field updated`)
}

async function ensureJsonField(name, fieldName, help = '') {
  const collection = await pb.collections.getOne(name)
  const fieldsKey = Array.isArray(collection.fields) ? 'fields' : 'schema'
  const fields = collection[fieldsKey] || []
  if (fields.some((field) => field.name === fieldName)) return
  await pb.collections.update(collection.id, { [fieldsKey]: [...fields, { name: fieldName, type: 'json', required: false, maxSize: 200000, help }] })
  console.log(`${name}.${fieldName}: field created`)
}

async function ensureBoolField(name, fieldName, help = '') {
  const collection = await pb.collections.getOne(name)
  const fieldsKey = Array.isArray(collection.fields) ? 'fields' : 'schema'
  const fields = collection[fieldsKey] || []
  if (fields.some((field) => field.name === fieldName)) return
  await pb.collections.update(collection.id, { [fieldsKey]: [...fields, { name: fieldName, type: 'bool', required: false, help }] })
  console.log(`${name}.${fieldName}: field created`)
}

await authAsSuperuser()

await updateCollection('categories', {
  listRule: readRule,
  viewRule: readRule,
  createRule: adminRule,
  updateRule: adminRule,
})

await updateCollection('products', {
  listRule: readRule,
  viewRule: readRule,
  createRule: adminRule,
  updateRule: cashierRule,
  deleteRule: adminRule,
})
await patchField('products', 'quantity', { required: false, min: 0 })
await ensureBoolField('products', 'allow_fractional', 'Whether this product can be stocked and sold in decimal quantities (e.g. rice by the kilogram).')

// Admin-only: these are the manager void/refund/cash-out approval codes.
// A cashier who can list this collection can read every manager's approval
// barcode and self-approve any override — approval must be verified
// server-side (see server/index.js authorizeManagerApproval), never by
// letting the client hold the code list.
await updateCollection('authorization_barcodes', {
  listRule: adminRule,
  viewRule: adminRule,
  createRule: adminRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

await updateCollection('product_barcode_labels', {
  listRule: readRule,
  viewRule: readRule,
  createRule: adminRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

await updateCollection('activity_logs', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: null,
  deleteRule: null,
})

await updateCollection('sales', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: cashierRule,
})
await patchField('sales', 'status', {
  values: ['completed', 'voided', 'adjusted'],
})

await updateCollection('sale_items', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
})
await patchField('sale_items', 'sale_id', { cascadeDelete: true })

await updateCollection('stock_movements', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})
await patchField('stock_movements', 'movement_type', {
  values: ['stock_in', 'stock_out', 'adjustment', 'void_return', 'sale', 'refund_return', 'exchange_return'],
})

await updateCollection('cash_register_sessions', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: cashierRule,
  deleteRule: adminRule,
})

await updateCollection('cash_movements', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

await updateCollection('cash_audits', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

await updateCollection('audit_reviews', {
  listRule: readRule,
  viewRule: readRule,
  createRule: adminRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

// Admin, or the account's own record only — a cashier must not be able to
// list every staff account (that exposes other cashiers' and managers'
// void_barcode, which is the same approval-code leak as
// authorization_barcodes above).
const selfOrAdminRule = '@request.auth.role = "admin" || id = @request.auth.id'
await updateCollection('users', {
  listRule: selfOrAdminRule,
  viewRule: selfOrAdminRule,
  createRule: adminRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})
await ensureJsonField('users', 'permissions', 'Allowed POS capabilities for this staff account. Empty keeps legacy access.')

console.log(`PocketBase rules configured for ${pbUrl}`)
