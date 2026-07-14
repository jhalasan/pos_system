import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import PocketBase from 'pocketbase'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const importHistory = !args.has('--catalog-only')
const preserveNegativeStock = args.has('--preserve-negative-stock')
const sourceDir = path.resolve('db_json_export')
const reportDir = path.resolve('migration_reports')
const batchSize = Math.max(1, Math.min(200, Number(process.env.LEGACY_IMPORT_BATCH_SIZE) || 200))
const concurrency = Math.max(1, Math.min(3, Number(process.env.LEGACY_IMPORT_CONCURRENCY) || 1))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function withRateLimitRetry(operation, attempts = 120) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation() }
    catch (error) {
      if (error?.status !== 429 || attempt >= attempts) throw error
      await delay(Math.min(30_000, 1_000 * (2 ** attempt)))
    }
  }
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(sourceDir, `${name}.json`), 'utf8'))

function recordId(prefix, value) {
  const id = `${prefix}${String(value).padStart(12, '0')}`
  if (!/^[a-z0-9]{15}$/.test(id)) throw new Error(`Invalid deterministic id: ${id}`)
  return id
}

function pocketBaseDate(value) {
  if (!value) return ''
  const normalized = String(value).trim().replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1')
  const date = new Date(normalized)
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString()
}

function groupBy(rows, key) {
  const result = new Map()
  for (const row of rows) {
    if (!result.has(row[key])) result.set(row[key], [])
    result.get(row[key]).push(row)
  }
  return result
}

const products = read('Product')
const productGroups = read('ProductGroup')
const barcodes = read('Barcode')
const stocks = read('Stock')
const users = read('User')
const documents = read('Document')
const documentTypes = read('DocumentType')
const documentItems = read('DocumentItem')
const payments = read('Payment')
const paymentTypes = read('PaymentType')
const barcodesByProduct = groupBy(barcodes, 'ProductId')
const stockByProduct = new Map()
for (const row of stocks) stockByProduct.set(row.ProductId, (stockByProduct.get(row.ProductId) || 0) + Number(row.Quantity || 0))
const documentTypeById = new Map(documentTypes.map((row) => [row.Id, row]))
const paymentTypeById = new Map(paymentTypes.map((row) => [row.Id, row]))
const paymentsByDocument = groupBy(payments, 'DocumentId')
const importedDocuments = documents.filter((row) => ['Sales', 'Refund'].includes(documentTypeById.get(row.DocumentTypeId)?.Name))
const importedDocumentIds = new Set(importedDocuments.map((row) => row.Id))
const importedItems = documentItems.filter((row) => importedDocumentIds.has(row.DocumentId))

const uncategorizedId = recordId('cat', 0)
const categoryPayloads = [
  { id: uncategorizedId, name: 'Uncategorized (Legacy)' },
  ...productGroups.map((row) => ({ id: recordId('cat', row.Id), name: row.Name || `Legacy Group ${row.Id}` })),
]

const productPayloads = products.map((product) => {
  const validBarcodes = (barcodesByProduct.get(product.Id) || []).map((row) => String(row.Value || '').trim()).filter(Boolean)
  const rawStock = stockByProduct.get(product.Id) || 0
  const quantity = preserveNegativeStock ? rawStock : Math.max(0, rawStock)
  return {
    id: recordId('prd', product.Id),
    barcode: validBarcodes[0] || `LEGACY-${product.Id}`,
    name: product.Name || `Legacy Product ${product.Id}`,
    base_unit: product.MeasurementUnit || 'pc',
    price: Math.max(0.01, Number(product.Price) || 0),
    cost: Math.max(0, Number(product.Cost) || 0),
    profitMargin: Math.min(100, Math.max(0, Number(product.Markup) || 0)),
    quantity,
    initial_stock: quantity,
    min_stock: 1,
    stock_unit: product.MeasurementUnit || 'pc',
    purchase_unit: product.MeasurementUnit || 'pc',
    conversion_quantity: 1,
    has_multiple_units: validBarcodes.length > 1,
    selling_units: validBarcodes.slice(1).map((barcode) => ({ unit: product.MeasurementUnit || 'pc', barcode, conversion: 1, price: Math.max(0.01, Number(product.Price) || 0) })),
    category: product.ProductGroupId ? recordId('cat', product.ProductGroupId) : uncategorizedId,
  }
})

const resetPassword = process.env.LEGACY_IMPORT_TEMP_PASSWORD || process.env.DEFAULT_CASHIER_PASSWORD || 'ChangeMeLegacy123!'
const userPayloads = users.map((user) => ({
  id: recordId('usr', user.Id),
  email: String(user.Email || '').trim().toLowerCase() || `legacy.user.${user.Id}@nexapos.local`,
  password: resetPassword,
  passwordConfirm: resetPassword,
  name: [user.FirstName, user.LastName].filter(Boolean).join(' ') || `Legacy User ${user.Id}`,
  role: Number(user.AccessLevel) >= 9 ? 'admin' : 'cashier',
  status: 'inactive',
  verified: true,
  quick_login_enabled: false,
}))

function paymentDetails(document) {
  const names = (paymentsByDocument.get(document.Id) || []).map((row) => paymentTypeById.get(row.PaymentTypeId)?.Name?.toUpperCase() || '')
  const gcash = names.some((name) => name.includes('GCASH') || name.includes('PAYMAYA'))
  const credit = names.some((name) => name.includes('CREDIT'))
  return { payment_method: gcash ? 'gcash' : 'cash', ref_number: credit ? `LEGACY-CREDIT:${document.Id}` : (gcash ? `LEGACY-EWALLET:${document.Id}` : '') }
}

const salePayloads = importedDocuments.map((document) => ({
  id: recordId('sal', document.Id),
  transaction_no: `99${String(document.Id).padStart(12, '0')}`,
  cashier_id: recordId('usr', document.UserId),
  total_amount: Number(document.Total) || 0,
  subtotal_amount: (Number(document.Total) || 0) + (Number(document.Discount) || 0),
  discount_amount: Number(document.Discount) || 0,
  status: documentTypeById.get(document.DocumentTypeId)?.Name === 'Refund' ? 'adjusted' : 'completed',
  created_at: pocketBaseDate(document.DateCreated || document.Date),
  ...paymentDetails(document),
}))
const saleItemPayloads = importedItems.map((item) => ({
  id: recordId('itm', item.Id), sale_id: recordId('sal', item.DocumentId), product_id: recordId('prd', item.ProductId),
  quantity_sold: Number(item.Quantity) || 0, base_quantity_sold: Number(item.Quantity) || 0,
  price_at_sale: Number(item.PriceAfterDiscount || item.Price) || 0.01,
}))

const duplicateEmails = [...new Set(userPayloads.map((row) => row.email).filter((email, index, all) => all.indexOf(email) !== index))]
const report = {
  generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', options: { importHistory, preserveNegativeStock, batchSize, concurrency },
  counts: { categories: categoryPayloads.length, products: productPayloads.length, users: userPayloads.length, sales: importHistory ? salePayloads.length : 0, saleItems: importHistory ? saleItemPayloads.length : 0 },
  transformations: {
    generatedBarcodes: productPayloads.filter((row) => row.barcode.startsWith('LEGACY-')).length,
    alternateBarcodes: productPayloads.reduce((sum, row) => sum + row.selling_units.length, 0),
    clampedNegativeStock: preserveNegativeStock ? 0 : products.filter((row) => (stockByProduct.get(row.Id) || 0) < 0).length,
    normalizedNonPositivePrices: products.filter((row) => Number(row.Price) <= 0).length,
    normalizedNonPositiveSaleItemPrices: importedItems.filter((row) => Number(row.PriceAfterDiscount || row.Price) <= 0).length,
    clampedProfitMargins: products.filter((row) => Number(row.Markup) < 0 || Number(row.Markup) > 100).length,
    uncategorizedProducts: products.filter((row) => !row.ProductGroupId).length,
    inactiveResetUsers: userPayloads.length,
    creditPaymentsMappedToCash: importedDocuments.filter((row) => paymentDetails(row).ref_number.startsWith('LEGACY-CREDIT')).length,
    normalizedTransactionNumbers: importedDocuments.length,
  }, warnings: duplicateEmails.length ? [`Duplicate user emails: ${duplicateEmails.join(', ')}`] : [],
}

fs.mkdirSync(reportDir, { recursive: true })
const reportPath = path.join(reportDir, apply ? 'legacy-import-result.json' : 'legacy-import-dry-run.json')
async function auth(pb) {
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD
  if (!email || !password) throw new Error('PocketBase superuser credentials are missing.')
  try { await withRateLimitRetry(() => pb.collection('_superusers').authWithPassword(email, password)) }
  catch (error) { if (error.status !== 404) throw error; await withRateLimitRetry(() => pb.collection('_admins').authWithPassword(email, password)) }
}
async function upsertBatches(pb, collection, rows) {
  let processed = 0
  let nextOffset = 0
  async function worker() {
    while (nextOffset < rows.length) {
      const offset = nextOffset
      nextOffset += batchSize
    const chunk = rows.slice(offset, offset + batchSize)
    const batch = pb.createBatch()
    for (const row of chunk) batch.collection(collection).upsert(row)
    try {
      await withRateLimitRetry(() => batch.send({ requestKey: null }))
    } catch (error) {
      throw new Error(`${collection} batch at offset ${offset} failed: ${JSON.stringify(error?.response || error?.data || { message: error?.message })}`)
    }
    processed += chunk.length
    if (processed % 1000 === 0 || processed === rows.length) console.log(`${collection}: ${processed}/${rows.length}`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}
if (report.warnings.length) { fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw new Error(`Validation failed: ${report.warnings.join('; ')}`) }
if (apply) {
  const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'); pb.autoCancellation(false); await auth(pb)
  const currentUsers = await pb.collection('users').getFullList({ fields: 'id,email' })
  const currentEmailOwners = new Map(currentUsers.map((row) => [String(row.email).toLowerCase(), row.id]))
  report.transformations.existingEmailCollisions = []
  for (const user of userPayloads) {
    const owner = currentEmailOwners.get(user.email)
    if (owner && owner !== user.id) {
      const originalEmail = user.email
      user.email = `legacy.user.${user.id.slice(3)}@nexapos.local`
      report.transformations.existingEmailCollisions.push({ originalEmail, replacementEmail: user.email })
    }
  }
  const currentProducts = await pb.collection('products').getFullList({ fields: 'id,barcode' })
  const currentBarcodeOwners = new Map(currentProducts.map((row) => [String(row.barcode).trim(), row.id]).filter(([barcode]) => barcode))
  report.transformations.existingBarcodeCollisions = []
  for (const product of productPayloads) {
    const owner = currentBarcodeOwners.get(product.barcode)
    if (owner && owner !== product.id) {
      const originalBarcode = product.barcode
      product.barcode = `LEGACY-COLLISION-${product.id.slice(3).replace(/^0+/, '') || '0'}`
      report.transformations.existingBarcodeCollisions.push({ originalBarcode, replacementBarcode: product.barcode, existingProductId: owner })
    }
  }
  const observedBatch = (await withRateLimitRetry(() => pb.settings.getAll())).batch
  const restoreBatch = { ...observedBatch, enabled: false, maxRequests: 50, timeout: 3 }
  await withRateLimitRetry(() => pb.settings.update({ batch: { ...observedBatch, enabled: true, maxRequests: Math.max(batchSize, observedBatch.maxRequests || 0), timeout: Math.max(60, observedBatch.timeout || 0) } }))
  try {
    await upsertBatches(pb, 'categories', categoryPayloads); await upsertBatches(pb, 'users', userPayloads); await upsertBatches(pb, 'products', productPayloads)
    if (importHistory) { await upsertBatches(pb, 'sales', salePayloads); await upsertBatches(pb, 'sale_items', saleItemPayloads) }
    report.completedAt = new Date().toISOString()
  } finally {
    await withRateLimitRetry(() => pb.settings.update({ batch: restoreBatch }))
  }
}
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(`${apply ? 'Import result' : 'Dry-run report'}: ${reportPath}`)
