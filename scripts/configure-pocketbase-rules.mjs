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

await updateCollection('authorization_barcodes', {
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

await updateCollection('sale_items', {
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
})

await updateCollection('users', {
  listRule: readRule,
  viewRule: readRule,
  createRule: adminRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

console.log(`PocketBase rules configured for ${pbUrl}`)
