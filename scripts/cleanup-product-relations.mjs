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

async function deleteRelatedRecords(collectionName, fieldName) {
  const records = await pb.collection(collectionName).getFullList({
    requestKey: null,
  }).catch(() => [])

  for (const record of records) {
    const productId = record[fieldName]
    if (!productId) continue
    try {
      await pb.collection(collectionName).delete(record.id, { requestKey: null })
      console.log(`Deleted ${collectionName}/${record.id} (${productId})`)
    } catch (error) {
      console.warn(`Skipped ${collectionName}/${record.id}: ${error?.message || error}`)
    }
  }
}

await authAsSuperuser()

await deleteRelatedRecords('stock_movements', 'product_id')
await deleteRelatedRecords('sale_items', 'product_id')

console.log('Cleanup complete')
