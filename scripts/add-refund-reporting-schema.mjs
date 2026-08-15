// M1: today, a refund/exchange only ever flips `sales.status` to
// "adjusted" in PocketBase -- the refunded amount, items, reason, approver,
// and timestamp exist ONLY in the cashier terminal's local Dexie DB. Wipe a
// terminal and every refund ever issued on it is gone; the cloud revenue
// reports have never netted out a single refund.
//
// This is an ADDITIVE-ONLY migration: it never mutates `sales.total_amount`
// (the original sale total is a fact and stays a fact); it only adds new
// fields/collections so reporting can NET refunds out separately. Run once
// against production PocketBase after reviewing this file.
//
//   node scripts/add-refund-reporting-schema.mjs
//
// This script was written and reviewed but NOT executed against a live
// PocketBase from this session (no production PocketBase connectivity, and
// per the client's choice, schema migrations are applied by them directly --
// see POS_AUDIT_REGISTER.md, M1). Dry-run against a local/staging PocketBase
// first if you have one.

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

async function ensureCollection(name, definition) {
  const existing = await pb.collections.getFirstListItem(`name = "${name}"`).catch(() => null)
  if (existing) {
    console.log(`${name}: collection already exists, skipping create`)
    return existing
  }
  const created = await pb.collections.create({ name, type: 'base', ...definition })
  console.log(`${name}: collection created`)
  return created
}

await authAsSuperuser()

// --- sales: additive reporting fields ------------------------------------
// total_amount is never touched. refunded_amount/refunded_units are the
// running total of everything refunded against this sale (a sale can be
// partially refunded more than once); refunded_at is the most recent
// adjustment's timestamp. A legacy row with none of these set must be
// treated by readers as "nothing refunded" -- see src/utils/saleTotals.js,
// which is written to return the full total/units unchanged for exactly
// that case.
await ensureField('sales', {
  name: 'refunded_amount',
  type: 'number',
  required: false,
  min: 0,
  help: 'Running total refunded against this sale across all adjustments. Additive only -- total_amount is never mutated.',
})
await ensureField('sales', {
  name: 'refunded_units',
  type: 'number',
  required: false,
  min: 0,
  help: 'Running total of item units refunded against this sale, for FSN/units-sold analytics to net out alongside revenue.',
})
await ensureField('sales', {
  name: 'refunded_at',
  type: 'date',
  required: false,
  help: 'Timestamp of the most recent refund/exchange adjustment against this sale.',
})

// --- sale_adjustments: the durable cloud record of each refund/exchange --
// adjustment_id is the idempotency anchor: it is the same UUID the cashier
// terminal already generates locally for each adjustment entry
// (saleRepository.js's adjustLocalSale), so a retried upload of the same
// adjustment can look itself up by this value instead of creating a
// duplicate. PocketBase's JS SDK does not expose a "unique index" option
// through this API the way the schema UI does -- if you want a hard
// database-level uniqueness constraint on adjustment_id, add it via the
// PocketBase admin UI after this script runs; the upload path (syncEngine.js)
// enforces idempotency by looking the value up before creating regardless.
await ensureCollection('sale_adjustments', {
  fields: [
    { name: 'sale_id', type: 'relation', required: true, collectionId: (await pb.collections.getOne('sales')).id, maxSelect: 1, cascadeDelete: false },
    { name: 'adjustment_id', type: 'text', required: true },
    { name: 'type', type: 'select', required: true, maxSelect: 1, values: ['refund', 'exchange'] },
    { name: 'amount', type: 'number', required: true, min: 0 },
    { name: 'items', type: 'json', required: false, maxSize: 200000 },
    { name: 'reason', type: 'text', required: false },
    { name: 'note', type: 'text', required: false },
    { name: 'approver_id', type: 'relation', required: false, collectionId: (await pb.collections.getOne('users')).id, maxSelect: 1, cascadeDelete: false },
    { name: 'cashier_id', type: 'relation', required: false, collectionId: (await pb.collections.getOne('users')).id, maxSelect: 1, cascadeDelete: false },
    { name: 'restock', type: 'bool', required: false },
    { name: 'created_at', type: 'date', required: false },
  ],
  listRule: readRule,
  viewRule: readRule,
  createRule: cashierRule,
  updateRule: adminRule,
  deleteRule: adminRule,
})

console.log('Refund reporting schema migration complete.')
