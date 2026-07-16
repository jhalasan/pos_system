import 'dotenv/config'
import PocketBase from 'pocketbase'

const apply = process.argv.includes('--apply')
const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090')
pb.autoCancellation(false)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function retry(operation, attempts = 20) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const transientNetworkError = error?.status === 0 && error?.isAbort === false
      if ((error?.status !== 429 && !transientNetworkError) || attempt >= attempts) throw error
      await delay(Math.min(10_000, 1000 * (2 ** attempt)))
    }
  }
}

async function authenticate() {
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD
  if (!email || !password) throw new Error('PocketBase superuser credentials are missing.')

  try {
    await retry(() => pb.collection('_superusers').authWithPassword(email, password))
  } catch (error) {
    if (error.status !== 404) throw error
    await retry(() => pb.collection('_admins').authWithPassword(email, password))
  }
}

async function all(collection) {
  return retry(() => pb.collection(collection).getFullList({ requestKey: null }))
}

async function remove(collection, records) {
  let completed = 0
  for (let offset = 0; offset < records.length; offset += 200) {
    const chunk = records.slice(offset, offset + 200)
    const batch = pb.createBatch()
    for (const record of chunk) batch.collection(collection).delete(record.id)
    await retry(() => batch.send({ requestKey: null }))
    completed += chunk.length
    console.log(`${collection}: deleted ${completed}/${records.length}`)
  }
}

async function restoreInventory(products) {
  let completed = 0
  for (let offset = 0; offset < products.length; offset += 200) {
    const chunk = products.slice(offset, offset + 200)
    const batch = pb.createBatch()
    for (const product of chunk) {
      batch.collection('products').update(product.id, { quantity: Number(product.initial_stock || 0) })
    }
    await retry(() => batch.send({ requestKey: null }))
    completed += chunk.length
    console.log(`products: restored inventory ${completed}/${products.length}`)
  }
}

await authenticate()

const deletionOrder = [
  'sale_items',
  'stock_movements',
  'cash_movements',
  'cash_audits',
  'audit_reviews',
  'cash_register_sessions',
  'sales',
  'activity_logs',
]

const available = new Set((await retry(() => pb.collections.getFullList())).map(({ name }) => name))
const records = {}
for (const collection of deletionOrder) {
  if (available.has(collection)) records[collection] = await all(collection)
}

const products = await all('products')
const changedProducts = products.filter(
  (product) => Number(product.quantity || 0) !== Number(product.initial_stock || 0),
)

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  retainedProducts: products.length,
  inventoryValuesToRestore: changedProducts.length,
  recordsToDelete: Object.fromEntries(
    Object.entries(records).map(([collection, rows]) => [collection, rows.length]),
  ),
}, null, 2))

if (apply) {
  const backupName = `pre_deployment_reset_${Date.now()}.zip`
  await retry(() => pb.backups.create(backupName))
  console.log(`Backup created: ${backupName}`)

  const settings = await retry(() => pb.settings.getAll())
  const previousBatch = { ...settings.batch }
  await retry(() => pb.settings.update({
    batch: { ...previousBatch, enabled: true, maxRequests: 200, timeout: 120 },
  }))

  try {
    for (const collection of deletionOrder) {
      if (records[collection]?.length) await remove(collection, records[collection])
    }
    if (changedProducts.length) await restoreInventory(changedProducts)
  } finally {
    await retry(() => pb.settings.update({ batch: previousBatch }))
  }

  console.log('Deployment data reset complete.')
}
