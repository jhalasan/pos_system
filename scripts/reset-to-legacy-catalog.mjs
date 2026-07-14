import 'dotenv/config'
import PocketBase from 'pocketbase'

const apply = process.argv.includes('--apply')
const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090')
pb.autoCancellation(false)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function retry(operation, attempts = 20) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation() }
    catch (error) {
      if (error?.status !== 429 || attempt >= attempts) throw error
      await delay(Math.min(30_000, 1000 * (2 ** attempt)))
    }
  }
}

async function authenticate() {
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD
  if (!email || !password) throw new Error('PocketBase superuser credentials are missing.')
  try { await retry(() => pb.collection('_superusers').authWithPassword(email, password)) }
  catch (error) {
    if (error.status !== 404) throw error
    await retry(() => pb.collection('_admins').authWithPassword(email, password))
  }
}

async function all(collection) {
  return retry(() => pb.collection(collection).getFullList({ requestKey: null }))
}

async function remove(collection, records) {
  let deleted = 0
  for (let offset = 0; offset < records.length; offset += 200) {
    const chunk = records.slice(offset, offset + 200)
    const batch = pb.createBatch()
    for (const record of chunk) batch.collection(collection).delete(record.id)
    await retry(() => batch.send({ requestKey: null }))
    deleted += chunk.length
    console.log(`${collection}: ${deleted}/${records.length}`)
  }
}

await authenticate()

const collections = await retry(() => pb.collections.getFullList())
const available = new Set(collections.map((collection) => collection.name))
const operationalOrder = [
  'sale_items',
  'stock_movements',
  'cash_movements',
  'cash_audits',
  'audit_reviews',
  'cash_register_sessions',
  'sales',
  'activity_logs',
]
const records = {}
for (const collection of operationalOrder) {
  if (available.has(collection)) records[collection] = await all(collection)
}

const products = await all('products')
const categories = await all('categories')
const legacyProducts = products.filter((record) => /^prd\d{12}$/.test(record.id))
const removeProducts = products.filter((record) => !/^prd\d{12}$/.test(record.id))
const legacyCategoryIds = new Set(legacyProducts.map((record) => String(record.category || '')).filter(Boolean))
const removeCategories = categories.filter((record) => !legacyCategoryIds.has(record.id))

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  retainedLegacyProducts: legacyProducts.length,
  removedProducts: removeProducts.length,
  removedCategories: removeCategories.length,
  removedOperationalRecords: Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, rows.length])),
}
console.log(JSON.stringify(summary, null, 2))

if (apply) {
  const backupName = `nexa_reset_${Date.now()}.zip`
  await retry(() => pb.backups.create(backupName))
  console.log(`Backup created: ${backupName}`)
  const settings = await retry(() => pb.settings.getAll())
  const previousBatch = { ...settings.batch }
  await retry(() => pb.settings.update({ batch: { ...previousBatch, enabled: true, maxRequests: 200, timeout: 120 } }))
  try {
    for (const collection of operationalOrder) {
      if (records[collection]?.length) await remove(collection, records[collection])
    }
    await remove('products', removeProducts)
    await remove('categories', removeCategories)
  } finally {
    await retry(() => pb.settings.update({ batch: previousBatch }))
  }
  console.log('Reset complete.')
}
