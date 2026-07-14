import 'dotenv/config'
import PocketBase from 'pocketbase'

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090')
pb.autoCancellation(false)
const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function retry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation() }
    catch (error) {
      if (error?.status !== 429 || attempt >= 12) throw error
      await delay(Math.min(30_000, 1_000 * (2 ** attempt)))
    }
  }
}

try { await retry(() => pb.collection('_superusers').authWithPassword(email, password)) }
catch (error) {
  if (error.status !== 404) throw error
  await retry(() => pb.collection('_admins').authWithPassword(email, password))
}

async function find(collection, filter) {
  return retry(() => pb.collection(collection).getFullList({ filter, requestKey: null }))
}

async function remove(collection, records) {
  for (const record of records) {
    await retry(() => pb.collection(collection).delete(record.id, { requestKey: null }))
    console.log(`Deleted ${collection}/${record.id}`)
  }
}

const products = await find('products', 'barcode ~ "^SAMPLE-" || name ~ "\\(sample\\)$"')
const productIds = new Set(products.map((record) => record.id))
for (const collection of ['stock_movements', 'sale_items']) {
  const related = (await find(collection, '')).filter((record) => productIds.has(String(record.product_id)))
  await remove(collection, related)
}

await remove('products', products)
await remove('sales', await find('sales', 'transaction_no = "202606160001" || transaction_no = "202606160002"'))
await remove('authorization_barcodes', await find('authorization_barcodes', 'code = "990000000001"'))
await remove('activity_logs', await find('activity_logs', 'description ~ "\\(sample\\)"'))
await remove('users', await find('users', 'email = "cashier.sample@nexapos.local"'))
await remove('categories', await find('categories', 'name ~ "\\(sample\\)$"'))

console.log(`Removed ${products.length} sample product(s) and their known seed records.`)
