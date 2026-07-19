import PocketBase, { LocalAuthStore } from 'pocketbase'
import { initializeAdminDb, adminDb } from '../offline/db'
import { cashierDb, initializeCashierDb } from '../../cashier-pos/offline/db'
import { refreshAdminLocalCache } from '../offline/cloudBootstrap'
import { AdminSyncEngine } from '../offline/syncEngine'
import { CashierSyncEngine } from '../../cashier-pos/offline/syncEngine'
import { copyAdminProductCatalogToCashier } from '../../cashier-pos/offline/catalogCache'
import {
  deriveStatus,
  getAllProducts,
  getLocalCategories,
  getProductByBarcode,
  replaceProductsFromCloud,
} from '../offline/productRepository'
import {
  isPocketBaseRateLimit,
  isPocketBaseRateLimited,
  pocketBaseRateLimitMessage,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { getTerminalId, getTerminalName } from '../../utils/terminalIdentity'
import { resolveRequiredProductPrice } from '../offline/productPricing'

const baseUrl = import.meta.env.VITE_POCKETBASE_URL

function requireBaseUrl() {
  if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for desktop admin access.')
}

export const pb = new PocketBase(baseUrl || 'http://127.0.0.1:8090', new LocalAuthStore('nexa_admin_pb_auth'))
pb.autoCancellation(false)

let adminSession = null
let runtimePromise = null
let syncEngine = null
let inventoryScanQueue = Promise.resolve()
let reachabilityPromise = null
let reachabilityCache = { value: false, expiresAt: 0 }
let productRefreshPromise = null
let lastProductRefreshAt = 0

function newId(prefix = 'local') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function startAdminRuntime() {
  runtimePromise ||= (async () => {
    requireBaseUrl()
    await initializeAdminDb()
    syncEngine = new AdminSyncEngine({ pb })
    syncEngine.addEventListener('syncerror', (event) => console.error(event.detail.error))
    syncEngine.start()

    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      refreshAdminLocalCache({ pb }).catch(rememberPocketBaseRateLimit)
    }

    return { syncEngine }
  })()

  return runtimePromise
}

async function isCloudReachable() {
  await startAdminRuntime()
  if (globalThis.navigator && !globalThis.navigator.onLine) return false
  if (isPocketBaseRateLimited()) return false
  if (Date.now() < reachabilityCache.expiresAt) return reachabilityCache.value
  if (reachabilityPromise) return reachabilityPromise

  reachabilityPromise = (async () => {
    try {
      await Promise.race([
        pb.health.check({ requestKey: null }),
        new Promise((_, reject) => globalThis.setTimeout(
          () => reject(new Error('Cloud health check timed out.')),
          1500,
        )),
      ])
      reachabilityCache = { value: true, expiresAt: Date.now() + 15_000 }
      return true
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      reachabilityCache = { value: false, expiresAt: Date.now() + 8_000 }
      return false
    } finally {
      reachabilityPromise = null
    }
  })()
  return reachabilityPromise
}

function reconcileAdminSyncStatus(operations, { force = false } = {}) {
  const failed = operations.filter((operation) => operation.status === 'failed').length
  const pending = operations.filter((operation) => ['pending', 'conflict'].includes(operation.status)).length
  const next = failed > 0
    ? { state: 'failed', message: `Auto-Sync Finished with ${failed} Failed.` }
    : pending > 0
      ? { state: 'waiting', message: `${pending} local change${pending === 1 ? '' : 's'} waiting to sync.` }
      : { state: 'succeeded', message: 'Everything is synchronized.' }

  let current = null
  try {
    current = JSON.parse(globalThis.localStorage?.getItem('nexa_sync_status_admin') || 'null')
  } catch {
    // A corrupt or unavailable status cache should not block queue maintenance.
  }

  const staleFailure = ['failed', 'waiting'].includes(current?.state)
  if (!force && !staleFailure) return
  if (current?.state === next.state && current?.message === next.message) return

  const stored = { ...next, updatedAt: new Date().toISOString() }
  try {
    globalThis.localStorage?.setItem('nexa_sync_status_admin', JSON.stringify(stored))
  } catch {
    // The live event still updates the UI when persistent storage is unavailable.
  }
  if (typeof globalThis.CustomEvent === 'function') {
    globalThis.dispatchEvent?.(new CustomEvent('nexa-sync-status', {
      detail: { scope: 'admin', ...next },
    }))
  }
}

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

function fileUrl(record, filename) {
  if (!filename) return ''
  return pb.files.getURL(record, filename)
}

function toProduct(record) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category
  const image = Array.isArray(record.product_img) ? record.product_img[0] : record.product_img

  return {
    id: record.id,
    sku: record.id,
    name: record.name || '',
    barcode: record.barcode || '',
    category: category?.name || firstRelation(record.category) || '',
    categoryId: firstRelation(record.category) || '',
    qty: Number(record.quantity) || 0,
    unit: record.base_unit || 'Piece',
    purchaseUnit: record.purchase_unit || record.purchaseUnit || 'Box',
    conversionQuantity: Number(record.conversion_quantity ?? record.conversionQuantity ?? 1) || 1,
    initialStock: Number(record.initial_stock ?? record.initialStock ?? 0) || 0,
    stockUnit: record.stock_unit || record.stockUnit || '',
    lowStock: Number(record.min_stock) || 0,
    price: Number(record.price) || 0,
    cost: Number(record.cost) || 0,
    profitMargin: Number(record.profitMargin) || 0,
    hasMultipleUnits: Boolean(record.has_multiple_units ?? record.hasMultipleUnits),
    image: image || '',
    imageUrl: fileUrl(record, image),
    tiers: [{ label: 'Retail', price: Number(record.price) || 0 }],
    sellingUnits: Array.isArray(record.selling_units)
      ? record.selling_units
      : (typeof record.selling_units === 'string' ? JSON.parse(record.selling_units || '[]') : []),
    status: deriveStatus(record),
    lifecycleStatus: record.lifecycle_status || record.lifecycleStatus || 'active',
  }
}

function isCriticalStock(product) {
  const status = deriveStatus(product)
  return status === 'critical' || status === 'out-of-stock'
}

function toSettingsUser(record) {
  const email = record.email || ''
  const name = record.name || email.split('@')[0] || 'User'
  const barcode = record.void_barcode || record.cashierBarcode || ''
  const role = record.role === 'manager' || (record.role === 'cashier' && String(barcode).startsWith('92'))
    ? 'manager'
    : (record.role || '')

  return {
    id: record.id,
    name,
    email,
    role,
    shift: record.shift || '',
    status: record.status || 'active',
    cashierId: record.id,
    cashierBarcode: barcode,
    quickLoginEnabled: Boolean(record.quick_login_enabled ?? record.quickLoginEnabled),
  }
}

function toCashierUser(record, sales = 0) {
  const image = Array.isArray(record.profile_img) ? record.profile_img[0] : record.profile_img
  const email = record.email || ''

  return {
    ...toSettingsUser(record),
    cashierId: record.id,
    name: record.name || email.split('@')[0] || 'Cashier',
    shift: record.shift || 'Morning',
    cashierBarcode: record.void_barcode || record.cashierBarcode || '',
    image: image || '',
    imageUrl: image ? pb.files.getURL(record, image, { thumb: '100x100' }) : '',
    sales: Number(sales) || 0,
    permissions: Array.isArray(record.permissions) ? record.permissions : [],
  }
}

function toCloudActivityLog(record) {
  const user = Array.isArray(record.expand?.user_id)
    ? record.expand.user_id[0]
    : record.expand?.user_id

  return {
    id: record.id,
    cloudId: record.id,
    user: user?.name || user?.email || record.user_id || 'System',
    userType: user?.role === 'cashier' ? 'Cashier' : 'Admin',
    action: record.action_type || '',
    detail: record.description || '',
    time: record.timestamp || record.created || new Date().toISOString(),
    source: 'cloud',
  }
}

function toAuthorizationBarcode(record) {
  const generatedBy = Array.isArray(record.expand?.generated_by)
    ? record.expand.generated_by[0]
    : record.expand?.generated_by

  return {
    id: record.id,
    barcode: record.code || '',
    label: record.label || 'Void and Discount Approval',
    status: record.status || 'active',
    generatedBy: generatedBy?.name || generatedBy?.email || 'Admin',
    createdAt: record.created || new Date().toISOString(),
  }
}

function pocketBaseErrorMessage(error, fallback = 'PocketBase rejected the request.') {
  const fieldErrors = error?.response?.data || error?.data?.data || {}
  const details = Object.entries(fieldErrors)
    .map(([field, value]) => {
      const message = value?.message || value?.code || String(value || '')
      return message ? `${field}: ${message}` : ''
    })
    .filter(Boolean)

  if (details.length) return details.join(' ')
  return error?.response?.message || error?.data?.message || error?.message || fallback
}

function loginErrorMessage(error) {
  if (isPocketBaseRateLimit(error)) return pocketBaseRateLimitMessage()
  const message = pocketBaseErrorMessage(error, '')
  if (/something went wrong|failed to authenticate|invalid login|invalid.*password|unauthorized/i.test(message)) {
    return 'Invalid email or password.'
  }
  return message || 'Unable to login right now.'
}

function localStorageErrorMessage(error) {
  if (typeof error === 'string') return error
  return error?.message || String(error || '')
}

function isIndexedDbKeyRangeError(error) {
  return /IDBKeyRange|valid key|bound/i.test(localStorageErrorMessage(error))
}

async function fetchCloudProducts() {
  const records = await pb.collection('products').getFullList({
    sort: 'name',
    expand: 'category',
    requestKey: null,
  })

  await replaceProductsFromCloud(records, pb).catch((error) => {
    if (!isIndexedDbKeyRangeError(error)) throw error
    console.warn('Unable to refresh the local product cache; using cloud products for this view.', error)
  })

  return records.map(toProduct)
}

async function salesByCashier() {
  const totals = new Map()
  const records = await pb.collection('sales').getFullList({
    filter: 'status != "voided"',
    requestKey: null,
  }).catch(() => [])

  for (const sale of records) {
    const cashierId = firstRelation(sale.cashier_id)
    if (!cashierId) continue
    totals.set(cashierId, (totals.get(cashierId) || 0) + (Number(sale.total_amount) || 0))
  }

  return totals
}

function mergeUsersById(...groups) {
  const users = new Map()
  for (const group of groups) {
    for (const user of group || []) {
      const id = user.id || user.email
      if (!id) continue
      users.set(id, { ...users.get(id), ...user })
    }
  }
  return [...users.values()]
}

async function localQuickLoginUsers(role) {
  await startAdminRuntime()
  return adminDb.users
    .where('role')
    .equals(role)
    .filter((user) => user.status === 'active' && Boolean(user.quick_login_enabled ?? user.quickLoginEnabled))
    .toArray()
}

function gcashPaymentFromSale(sale) {
  let paymentMethod = sale.payment_method || sale.paymentMethod || ''
  let refNumber = sale.ref_number || sale.refNumber || ''
  let splitPayments = null

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }
  if (!paymentMethod && refNumber) paymentMethod = 'gcash'

  const totalAmount = Number(sale.total_amount ?? sale.totalAmount) || 0
  const splitGcash = Number(splitPayments?.gcash) || 0
  const amount = paymentMethod === 'split' ? splitGcash : totalAmount
  if (paymentMethod !== 'gcash' && splitGcash <= 0) return null

  const cashier = Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id

  return {
    id: sale.id,
    transactionNo: sale.transaction_no || sale.transactionNo || sale.id,
    createdAt: sale.created_at || sale.createdAt || sale.created,
    cashierName: cashier?.name || cashier?.email || firstRelation(sale.cashier_id) || '',
    paymentType: paymentMethod === 'split' ? 'Split' : 'GCash',
    amount,
    totalAmount,
    cashAmount: paymentMethod === 'split' ? Number(splitPayments?.cash) || 0 : 0,
    referenceNumber: paymentMethod === 'split' ? String(splitPayments?.gcashRef || '') : refNumber,
    status: sale.status || 'completed',
  }
}

function parseSalePayment(sale) {
  let paymentMethod = sale.payment_method || sale.paymentMethod || 'cash'
  let refNumber = sale.ref_number || sale.refNumber || ''
  let splitPayments = null

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }
  if ((!paymentMethod || paymentMethod === 'cash') && refNumber && !String(refNumber).startsWith('split:')) {
    paymentMethod = 'gcash'
  }
  if (!paymentMethod) paymentMethod = 'cash'

  return { paymentMethod, refNumber, splitPayments }
}

function saleItemQuantity(item) {
  return Number(item.quantity_sold ?? item.quantity ?? item.qty) || 0
}

function saleItemPrice(item, product) {
  return Number(item.price_at_sale ?? item.price ?? item.unit_price ?? product?.price) || 0
}

function productNameKey(value) {
  return String(value || '').trim().toLowerCase()
}

function buildProductLookup(products = []) {
  return {
    byId: new Map(products.map((product) => [String(product.id), product])),
    byBarcode: new Map(products.map((product) => [String(product.barcode || '').trim(), product]).filter(([barcode]) => barcode)),
    byName: new Map(products.map((product) => [productNameKey(product.name), product]).filter(([name]) => name)),
  }
}

function expandedSaleItemProduct(item) {
  return Array.isArray(item.expand?.product_id)
    ? item.expand.product_id[0]
    : item.expand?.product_id
}

function resolveSaleItemProduct(item, lookup) {
  const productId = firstRelation(item.product_id ?? item.productId)
  const expandedProduct = expandedSaleItemProduct(item)
  const barcode = String(item.barcode || expandedProduct?.barcode || '').trim()
  const name = productNameKey(item.name || expandedProduct?.name)

  return lookup.byId.get(String(productId || ''))
    || lookup.byBarcode.get(barcode)
    || lookup.byName.get(name)
    || null
}

function receiptItemFromCloud(item) {
  const product = Array.isArray(item.expand?.product_id)
    ? item.expand.product_id[0]
    : item.expand?.product_id

  return {
    productId: firstRelation(item.product_id) || item.id,
    id: item.id,
    name: product?.name || item.product_id || 'Product',
    barcode: product?.barcode || '',
    category: product?.category || product?.category_name || '',
    quantity: saleItemQuantity(item),
    price: saleItemPrice(item, product),
  }
}

async function receiptRecordFromCloudSale(sale) {
  const cashier = Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id
  const items = await pb.collection('sale_items').getFullList({
    filter: pb.filter('sale_id = {:saleId}', { saleId: sale.id }),
    sort: 'created',
    expand: 'product_id',
    requestKey: null,
  }).catch(() => [])
  const { paymentMethod, refNumber, splitPayments } = parseSalePayment(sale)
  const status = sale.status || 'completed'

  return {
    id: sale.id,
    saleId: sale.id,
    transactionNo: sale.transaction_no || sale.transactionNo || sale.id,
    receiptNo: sale.transaction_no || sale.transactionNo || sale.id,
    createdAt: sale.created_at || sale.createdAt || sale.created,
    cashierId: firstRelation(sale.cashier_id) || '',
    cashierName: cashier?.name || cashier?.email || firstRelation(sale.cashier_id) || '',
    customerName: sale.customer_name || sale.customerName || '',
    totalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    subtotalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod,
    refNumber,
    splitPayments,
    cashAmount: paymentMethod === 'cash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : 0,
    gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : 0,
    status: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Completed',
    rawStatus: status,
    actionStatus: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Reprint available',
    itemCount: items.length ? items.reduce((sum, item) => sum + saleItemQuantity(item), 0) : null,
    missingItems: items.length === 0,
    items: items.map(receiptItemFromCloud),
  }
}

function receiptRecordFromLocalSale(sale) {
  const { paymentMethod, refNumber, splitPayments } = parseSalePayment(sale)
  const status = sale.status || 'completed'
  const items = sale.items || []

  return {
    id: sale.clientSaleId || sale.id || sale.transactionNo,
    saleId: sale.clientSaleId || sale.id || sale.transactionNo,
    transactionNo: sale.transactionNo,
    receiptNo: sale.transactionNo,
    createdAt: sale.createdAt,
    cashierId: sale.cashierId || '',
    cashierName: sale.cashierName || sale.cashierId || '',
    customerName: sale.customerName || '',
    totalAmount: Number(sale.totalAmount) || 0,
    subtotalAmount: Number(sale.subtotalAmount || sale.totalAmount) || 0,
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod,
    refNumber,
    splitPayments,
    cashAmount: sale.cashAmount,
    gcashAmount: sale.gcashAmount,
    status: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Completed',
    rawStatus: status,
    actionStatus: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Reprint available',
    itemCount: items.length ? items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) : null,
    items,
    adjustments: sale.adjustments || [],
    adjustedAmount: (sale.adjustments || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
    syncStatus: sale.syncStatus || 'pending',
  }
}

function filterReceiptRecords(records, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase()
  const cashierName = String(filters.cashierName || '').trim().toLowerCase()
  const status = String(filters.status || 'all').trim().toLowerCase()
  const action = String(filters.action || 'all').trim().toLowerCase()
  const fromTime = filters.fromDate ? new Date(`${filters.fromDate}T00:00:00`).getTime() : null
  const toTime = filters.toDate ? new Date(`${filters.toDate}T23:59:59.999`).getTime() : null

  return records.filter((record) => {
    const createdTime = new Date(record.createdAt).getTime()
    const queryMatches = !q || [
      record.transactionNo,
      record.receiptNo,
      record.cashierName,
      record.paymentMethod,
    ].some((value) => String(value || '').toLowerCase().includes(q))
    const cashierMatches = !cashierName || String(record.cashierName || '').toLowerCase() === cashierName
    const statusMatches = status === 'all' || String(record.rawStatus || '').toLowerCase() === status
    const actionMatches = action === 'all'
      || (action === 'reprintable' && record.rawStatus !== 'voided')
      || (action === 'voided' && record.rawStatus === 'voided')
    const dateMatches = (!fromTime || createdTime >= fromTime) && (!toTime || createdTime <= toTime)
    return queryMatches && cashierMatches && statusMatches && actionMatches && dateMatches
  })
}

async function fetchReceiptRecords(filters = {}) {
  await startAdminRuntime()
  const localRecords = (await localCashierCompletedSales()).map(receiptRecordFromLocalSale)
  await initializeCashierDb()
  const cachedRecords = cashierDb.tables.some((table) => table.name === 'receiptCache')
    ? await cashierDb.receiptCache.toArray()
    : []
  if (!(await isCloudReachable())) return filterReceiptRecords([...localRecords, ...cachedRecords], filters)

  let sales
  try {
    sales = await pb.collection('sales').getFullList({
      sort: '-created_at,-created',
      expand: 'cashier_id',
      requestKey: null,
    })
  } catch {
    // A failed cloud request is not evidence that cached receipts were
    // deleted. Keep the offline history until a successful read can reconcile it.
    return filterReceiptRecords([...localRecords, ...cachedRecords], filters)
  }
  const cloudRecords = await Promise.all(sales.map(receiptRecordFromCloudSale))
  const pendingSales = await cashierDb.pendingSales.toArray()
  const pendingIds = new Set(pendingSales.map((sale) => String(sale.clientSaleId || '')))
  const pendingTransactionNos = new Set(pendingSales.map((sale) => String(sale.transactionNo || '')).filter(Boolean))
  const cloudIds = new Set(cloudRecords.flatMap((record) => [record.id, record.saleId].map((value) => String(value || '')).filter(Boolean)))
  const cloudTransactionNos = new Set(cloudRecords.map((record) => String(record.transactionNo || '')).filter(Boolean))
  const retainedLocalRecords = localRecords.filter((record) => (
    pendingIds.has(String(record.saleId || record.id || ''))
    || pendingTransactionNos.has(String(record.transactionNo || ''))
    || cloudIds.has(String(record.saleId || record.id || ''))
    || cloudTransactionNos.has(String(record.transactionNo || ''))
  ))

  if (cashierDb.tables.some((table) => table.name === 'receiptCache')) {
    await cashierDb.receiptCache.clear()
    if (cloudRecords.length) {
      await cashierDb.receiptCache.bulkPut(cloudRecords.map((record) => ({ ...record, id: record.id || record.saleId || record.transactionNo })))
    }
  }
  if (cashierDb.tables.some((table) => table.name === 'completedSales')) {
    await cashierDb.completedSales
      .filter((sale) => (
        !pendingIds.has(String(sale.clientSaleId || ''))
        && !pendingTransactionNos.has(String(sale.transactionNo || ''))
        && !cloudIds.has(String(sale.clientSaleId || ''))
        && !cloudTransactionNos.has(String(sale.transactionNo || ''))
      ))
      .delete()
  }
  const merged = new Map()

  for (const record of cloudRecords) {
    merged.set(record.transactionNo || record.id, record)
  }
  for (const record of retainedLocalRecords) {
    const key = record.transactionNo || record.id
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, record)
      continue
    }

    const localOverridesStatus = ['adjusted', 'voided'].includes(record.rawStatus)
    merged.set(key, {
      ...existing,
      ...record,
      // Local completedSales contains the original offline timestamp, totals,
      // discounts, and line items. Keep those details after upload, while a
      // later cloud-side void/adjustment remains authoritative for status.
      id: existing.id || record.id,
      saleId: existing.saleId || record.saleId,
      status: localOverridesStatus ? record.status : existing.status || record.status,
      rawStatus: localOverridesStatus ? record.rawStatus : existing.rawStatus || record.rawStatus,
      actionStatus: localOverridesStatus ? record.actionStatus : existing.actionStatus || record.actionStatus,
      missingItems: (record.items || []).length > 0 ? false : existing.missingItems,
    })
  }

  return filterReceiptRecords([...merged.values()], filters)
}

async function fetchGcashPayments() {
  await startAdminRuntime()
  const localPayments = (await localCashierCompletedSales())
    .map((sale) => gcashPaymentFromSale(localSaleAsCloudLike(sale)))
    .filter(Boolean)
  if (!(await isCloudReachable())) return localPayments

  const records = await pb.collection('sales').getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    requestKey: null,
  }).catch(() => [])

  const merged = new Map()
  for (const payment of records.map(gcashPaymentFromSale).filter(Boolean)) {
    merged.set(`${payment.transactionNo}-${payment.paymentType}`, payment)
  }
  for (const payment of localPayments) {
    merged.set(`${payment.transactionNo}-${payment.paymentType}`, payment)
  }
  return [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function refreshProductsInBackground() {
  if (productRefreshPromise) return productRefreshPromise
  if (Date.now() - lastProductRefreshAt < 30_000) return Promise.resolve()
  productRefreshPromise = isCloudReachable()
    .then((online) => online ? fetchCloudProducts() : null)
    .then((result) => {
      if (result) lastProductRefreshAt = Date.now()
      return result
    })
    .catch(rememberPocketBaseRateLimit)
    .finally(() => { productRefreshPromise = null })
  return productRefreshPromise
}

function cashierPayload(data) {
  const requestedRole = String(data.role || '').trim() === 'manager' ? 'manager' : 'cashier'
  const cashierBarcode = String(data.cashierBarcode || data.void_barcode || '').trim()
  const staffBarcode = requestedRole === 'manager' && cashierBarcode && !cashierBarcode.startsWith('92')
    ? `92${cashierBarcode}`
    : cashierBarcode
  const payload = {
    name: String(data.name || '').trim(),
    email: String(data.email || '').trim(),
    shift: data.shift || 'Morning',
    status: data.status || 'active',
    role: 'cashier',
    emailVisibility: true,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
  }

  if (staffBarcode) payload.void_barcode = staffBarcode

  if (String(data.password || '').trim()) {
    payload.password = data.password
    payload.passwordConfirm = data.passwordConfirm || data.password
  }

  return payload
}

function cashierBody(data) {
  const payload = cashierPayload(data)
  if (!data.imageFile) return payload

  const formData = new FormData()
  for (const [key, value] of Object.entries(payload)) {
    formData.append(key, key === 'permissions' ? JSON.stringify(value || []) : (value ?? ''))
  }
  formData.append('profile_img', data.imageFile)
  return formData
}

function cashierUpdateBody(data) {
  const body = cashierBody(data)
  const removeSensitiveFields = (target) => {
    target.delete('email')
    target.delete('password')
    target.delete('passwordConfirm')
  }

  if (body instanceof FormData) {
    removeSensitiveFields(body)
    return body
  }

  delete body.email
  delete body.password
  delete body.passwordConfirm
  return body
}

async function cacheUsers(records) {
  const normalizedRecords = records.map((record) => ({
    ...record,
    id: String(record?.id || record?.cashierId || '').trim(),
  })).filter((record) => record.id)
  const cachedUsers = await adminDb.users.bulkGet(normalizedRecords.map((record) => record.id))
  await adminDb.users.bulkPut(normalizedRecords.map((record, index) => ({
      ...cachedUsers[index],
      id: record.id,
      email: record.email,
      name: record.name || record.email,
      role: record.role,
      shift: record.shift || '',
      status: record.status || 'active',
      quick_login_enabled: Boolean(record.quick_login_enabled),
      cashierBarcode: record.void_barcode || record.cashierBarcode || '',
      void_barcode: record.void_barcode || record.cashierBarcode || '',
      profile_img: record.profile_img || cachedUsers[index]?.profile_img || '',
      imageUrl: (() => {
        const image = Array.isArray(record.profile_img) ? record.profile_img[0] : record.profile_img
        return image ? pb.files.getURL(record, image, { thumb: '100x100' }) : (cachedUsers[index]?.imageUrl || '')
      })(),
      emailVisibility: Boolean(record.emailVisibility),
      updated: record.updated || new Date().toISOString(),
    })))
}

async function ensureQuickLoginEmailVisibility(records = []) {
  return Promise.all(records.map(async (record) => {
    if (!record?.quick_login_enabled || record.emailVisibility) return record

    try {
      return await pb.collection('users').update(record.id, { emailVisibility: true }, { requestKey: null })
    } catch {
      return record
    }
  }))
}

function saleDate(sale) {
  return new Date(sale.created_at || sale.createdAt || sale.created)
}

async function localCashierCompletedSales() {
  try {
    await initializeCashierDb()
    if (!cashierDb.tables.some((table) => table.name === 'completedSales')) return []
    return cashierDb.completedSales.orderBy('createdAt').reverse().toArray()
  } catch {
    return []
  }
}

function localSaleItems(sale) {
  return (sale.items || []).map((item, index) => ({
    id: `${sale.clientSaleId || sale.id || sale.transactionNo}-item-${index}`,
    sale_id: sale.clientSaleId || sale.id,
    saleId: sale.clientSaleId || sale.id,
    product_id: item.productId || item.id,
    productId: item.productId || item.id,
    name: item.name,
    barcode: item.barcode,
    quantity_sold: Number(item.quantity) || 0,
    price_at_sale: Number(item.price) || 0,
  }))
}

function localSaleAsCloudLike(sale) {
  return {
    ...sale,
    id: sale.clientSaleId || sale.id || sale.transactionNo,
    transaction_no: sale.transactionNo,
    created_at: sale.createdAt,
    total_amount: sale.totalAmount,
    payment_method: sale.paymentMethod,
    ref_number: sale.refNumber,
    cashier_id: sale.cashierId,
    status: sale.status || 'completed',
  }
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function lastMonths(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1)
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleString('en-US', { month: 'short' }),
      value: 0,
    }
  })
}

function lastDays(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (count - 1 - index))
    return {
      key: dateKey(date),
      label: date.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
      value: 0,
    }
  })
}

function weekStart(date) {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  return start
}

function weekKey(date) {
  return dateKey(weekStart(date))
}

function lastWeeks(count, now = new Date()) {
  const currentWeek = weekStart(now)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(currentWeek)
    date.setDate(date.getDate() - (7 * (count - 1 - index)))
    return {
      key: dateKey(date),
      label: date.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
      value: 0,
    }
  })
}

function lastYears(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const year = now.getFullYear() - (count - 1 - index)
    return {
      key: String(year),
      label: String(year),
      value: 0,
    }
  })
}

function trend(current, previous) {
  if (!previous) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

function analyticsSaleSource(sale = {}) {
  const transactionNo = String(sale.transaction_no || sale.transactionNo || '')
  if (['202606160001', '202606160002'].includes(transactionNo)) return 'sample'
  if (/^sal\d{12}$/.test(String(sale.id || '')) || /^99\d{12}$/.test(transactionNo)) return 'legacy'
  return 'live'
}

function filterAnalyticsRecords(sales = [], saleItems = [], options = {}) {
  const source = options.source || 'all'
  const start = options.from ? new Date(`${options.from}T00:00:00`) : null
  const end = options.to ? new Date(`${options.to}T23:59:59.999`) : null
  const filteredSales = sales.filter((sale) => {
    const created = saleDate(sale)
    return (source === 'all' || analyticsSaleSource(sale) === source)
      && (!start || created >= start) && (!end || created <= end)
  })
  const ids = new Set(filteredSales.map((sale) => sale.id))
  return {
    sales: filteredSales,
    saleItems: saleItems.filter((item) => ids.has(firstRelation(item.sale_id ?? item.saleId))),
  }
}

function buildDashboardFromRecords(products, sales = [], saleItems = [], now = new Date(), options = {}) {
  const filtered = filterAnalyticsRecords(sales, saleItems, options)
  sales = filtered.sales
  saleItems = filtered.saleItems
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const completedSales = sales.filter((sale) => (sale.status || 'completed') !== 'voided')
  const dailySales = completedSales
    .filter((sale) => saleDate(sale) >= todayStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount ?? sale.totalAmount) || 0), 0)
  const yesterdaySales = completedSales
    .filter((sale) => {
      const created = saleDate(sale)
      return created >= yesterdayStart && created < todayStart
    })
    .reduce((sum, sale) => sum + (Number(sale.total_amount ?? sale.totalAmount) || 0), 0)
  const monthlySales = completedSales
    .filter((sale) => saleDate(sale) >= monthStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount ?? sale.totalAmount) || 0), 0)
  const lastMonthSales = completedSales
    .filter((sale) => {
      const created = saleDate(sale)
      return created >= lastMonthStart && created < monthStart
    })
    .reduce((sum, sale) => sum + (Number(sale.total_amount ?? sale.totalAmount) || 0), 0)
  const totalRevenue = completedSales.reduce((sum, sale) => sum + (Number(sale.total_amount ?? sale.totalAmount) || 0), 0)

  const productLookup = buildProductLookup(products)
  const completedSaleIds = new Set(completedSales.map((sale) => sale.id))
  const productSales = new Map()
  let selectedUnitsSold = 0

  for (const item of saleItems) {
    const saleId = firstRelation(item.sale_id ?? item.saleId)
    if (!completedSaleIds.has(saleId)) continue

    const quantity = Number(item.quantity_sold ?? item.quantity) || 0
    selectedUnitsSold += quantity
    const product = resolveSaleItemProduct(item, productLookup)
    const productId = product?.id || firstRelation(item.product_id ?? item.productId)
    if (!productId) continue

    const expandedProduct = expandedSaleItemProduct(item)
    const current = productSales.get(productId) || {
      id: productId,
      name: product?.name || item.name || expandedProduct?.name || productId,
      category: product?.category || expandedProduct?.category || '',
      units: 0,
    }
    current.units += quantity
    productSales.set(productId, current)
  }

  const hourlySales = Array.from({ length: 24 }, (_, hour) => ({
    label: `${String(hour).padStart(2, '0')}:00`,
    value: 0,
  }))
  for (const sale of completedSales) {
    const created = saleDate(sale)
    if (created < todayStart) continue
    hourlySales[created.getHours()].value += Number(sale.total_amount ?? sale.totalAmount) || 0
  }

  const monthlyTrend = lastMonths(8, now)
  const dailyTrend = lastDays(7, now)
  const weeklyTrend = lastWeeks(8, now)
  const yearlyTrend = lastYears(5, now)
  const monthlyTrendByKey = new Map(monthlyTrend.map((item) => [item.key, item]))
  const dailyTrendByKey = new Map(dailyTrend.map((item) => [item.key, item]))
  const weeklyTrendByKey = new Map(weeklyTrend.map((item) => [item.key, item]))
  const yearlyTrendByKey = new Map(yearlyTrend.map((item) => [item.key, item]))
  for (const sale of completedSales) {
    const created = saleDate(sale)
    const amount = Number(sale.total_amount ?? sale.totalAmount) || 0
    const day = dailyTrendByKey.get(dateKey(created))
    if (day) day.value += amount
    const week = weeklyTrendByKey.get(weekKey(created))
    if (week) week.value += amount
    const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`
    const month = monthlyTrendByKey.get(key)
    if (month) month.value += amount
    const year = yearlyTrendByKey.get(String(created.getFullYear()))
    if (year) year.value += amount
  }

  const criticalStockProducts = products
    .filter(isCriticalStock)
    .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0))
  const criticalAlerts = criticalStockProducts
    .slice(0, 8)
    .map((product) => ({ name: product.name, left: product.qty }))
  const currentStockUnits = products.reduce((sum, product) => sum + (Number(product.qty) || 0), 0)
  const paymentTotals = completedSales.reduce((totals, sale) => {
    const method = String(sale.payment_method || sale.paymentMethod || 'cash').toLowerCase()
    const amount = Number(sale.total_amount ?? sale.totalAmount) || 0
    if (method === 'gcash') totals.gcash += amount
    else totals.cash += amount
    return totals
  }, { cash: 0, gcash: 0 })
  const inventoryHealth = [
    { label: 'In Stock', value: products.filter((p) => deriveStatus(p) === 'in-stock').length, color: '#16a34a' },
    { label: 'Low', value: products.filter((p) => deriveStatus(p) === 'low').length, color: '#f59e0b' },
    { label: 'Critical', value: products.filter((p) => deriveStatus(p) === 'critical').length, color: '#f97316' },
    { label: 'Out of Stock', value: products.filter((p) => deriveStatus(p) === 'out-of-stock').length, color: '#ef4444' },
  ]
  const topCategories = new Map()
  for (const product of productSales.values()) topCategories.set(product.category || 'Uncategorized', (topCategories.get(product.category || 'Uncategorized') || 0) + product.units)
  const dataQuality = {
    generatedBarcodes: products.filter((p) => !p.barcode || String(p.barcode).startsWith('LEGACY-')).length,
    uncategorized: products.filter((p) => !p.category || /uncategorized/i.test(p.category)).length,
    nonPositivePrices: products.filter((p) => Number(p.price) <= 0).length,
  }

  return {
    stats: {
      dailySales,
      dailySalesTrend: trend(dailySales, yesterdaySales),
      monthlySales,
      monthlySalesTrend: trend(monthlySales, lastMonthSales),
      totalRevenue,
      totalRevenueTrend: 0,
      criticalStock: criticalStockProducts.length,
      transactionCount: completedSales.length,
      averageSale: completedSales.length ? totalRevenue / completedSales.length : 0,
      cashSales: paymentTotals.cash,
      gcashSales: paymentTotals.gcash,
      unitsSold: selectedUnitsSold,
      voidCount: sales.filter((sale) => (sale.status || 'completed') === 'voided').length,
    },
    criticalAlerts,
    productInOut: [
      { label: 'Current Stock', value: currentStockUnits, color: '#16a34a' },
      { label: 'Units Sold', value: selectedUnitsSold, color: '#ef4444' },
    ],
    topProducts: [...productSales.values()]
      .filter((product) => product.units > 0)
      .sort((a, b) => b.units - a.units)
      .slice(0, 5),
    hourlySales,
    dailySales: dailyTrend,
    weeklySales: weeklyTrend,
    monthlySales: monthlyTrend,
    yearlySales: yearlyTrend,
    analyticsMeta: { source: options.source || 'all', from: options.from || '', to: options.to || '', salesCount: completedSales.length },
    inventoryHealth,
    paymentBreakdown: [
      { label: 'Cash', value: paymentTotals.cash, color: '#16a34a' },
      { label: 'GCash', value: paymentTotals.gcash, color: '#2563eb' },
    ],
    recentTransactions: [...completedSales].sort((a, b) => saleDate(b) - saleDate(a)).slice(0, 5).map((sale) => ({
      id: sale.id, transactionNo: sale.transaction_no || sale.transactionNo || sale.id,
      amount: Number(sale.total_amount ?? sale.totalAmount) || 0,
      paymentMethod: sale.payment_method || sale.paymentMethod || 'cash', createdAt: saleDate(sale).toISOString(),
    })),
    topCategories: [...topCategories].map(([name, units]) => ({ name, units })).sort((a, b) => b.units - a.units).slice(0, 5),
    dataQuality,
  }
}

function buildFsnMetrics(products = [], sales = [], saleItems = [], now = new Date()) {
  const completedSales = sales.filter((sale) => (sale.status || 'completed') !== 'voided')
  const completedSaleIds = new Set(completedSales.map((sale) => sale.id))
  const salesById = new Map(completedSales.map((sale) => [sale.id, sale]))
  const ninetyDaysAgo = new Date(now)
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const productLookup = buildProductLookup(products)
  const metrics = new Map()

  for (const item of saleItems) {
    const saleId = firstRelation(item.sale_id ?? item.saleId)
    if (!completedSaleIds.has(saleId)) continue
    const sale = salesById.get(saleId)
    if (!sale) continue
    const product = resolveSaleItemProduct(item, productLookup)
    const productId = product?.id || firstRelation(item.product_id ?? item.productId)
    if (!productId) continue

    const quantity = saleItemQuantity(item)
    const soldAt = saleDate(sale)
    const current = metrics.get(productId) || { units90: 0, totalUnits: 0, lastSoldAt: null }
    current.totalUnits += quantity
    if (soldAt >= ninetyDaysAgo) current.units90 += quantity
    if (!current.lastSoldAt || soldAt > current.lastSoldAt) current.lastSoldAt = soldAt
    metrics.set(productId, current)
  }

  return metrics
}

function classifyFsnProduct(product, metric, now = new Date()) {
  const lastSoldAt = metric?.lastSoldAt || null
  const daysSinceLastSale = lastSoldAt
    ? Math.floor((now - lastSoldAt) / (1000 * 60 * 60 * 24))
    : null
  const units90 = Number(metric?.units90) || 0
  const averageMonthlyUnits = units90 / 3

  if (units90 >= 15 || (units90 >= 6 && daysSinceLastSale !== null && daysSinceLastSale <= 30)) {
    return {
      ...product,
      fsn: 'Fast-moving',
      fsnReason: `${units90} unit(s) sold in the last 90 days`,
      units90,
      averageMonthlyUnits,
      lastSoldAt,
      daysSinceLastSale,
    }
  }

  if (units90 > 0 && daysSinceLastSale !== null && daysSinceLastSale <= 90) {
    return {
      ...product,
      fsn: 'Slow-moving',
      fsnReason: `${units90} unit(s) sold in the last 90 days`,
      units90,
      averageMonthlyUnits,
      lastSoldAt,
      daysSinceLastSale,
    }
  }

  return {
    ...product,
    fsn: 'Non-moving',
    fsnReason: lastSoldAt ? `No sales in the last ${daysSinceLastSale} days` : 'No recorded sales yet',
    units90,
    averageMonthlyUnits,
    lastSoldAt,
    daysSinceLastSale,
  }
}

function assertAdmin() {
  const user = pb.authStore.record || adminSession
  if ((!pb.authStore.isValid && !adminSession) || user?.role !== 'admin') {
    throw new Error('Admin login is required.')
  }
}

async function cacheAdminLogin(record, password) {
  const normalizedEmail = String(record.email || '').trim().toLowerCase()
  const cached = {
    id: record.id,
    email: normalizedEmail,
    name: record.name || record.email,
    role: record.role,
    status: record.status || 'active',
    passwordHash: await sha256(`${normalizedEmail}:${password}`),
    updated: new Date().toISOString(),
  }
  await adminDb.users.put(cached)
  adminSession = cached
}

async function offlineLogin(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const cached = await adminDb.users.where('email').equalsIgnoreCase(normalizedEmail).first()
  if (!cached || cached.role !== 'admin' || cached.status === 'inactive') {
    throw new Error('Admin login requires internet the first time on this device.')
  }

  const passwordHash = await sha256(`${normalizedEmail}:${password}`)
  const legacyPasswordHash = await sha256(`${email}:${password}`)
  if (passwordHash !== cached.passwordHash && legacyPasswordHash !== cached.passwordHash) {
    throw new Error('Failed to authenticate.')
  }

  adminSession = cached
  await recordActivity('Login', 'Signed in to admin dashboard.')
  return { user: cached, offline: true }
}

async function imageData(data) {
  if (!data.imageFile) return {}
  return {
    imageBlob: data.imageFile,
    imageName: data.imageFile.name || 'product-image.webp',
    imageUrl: URL.createObjectURL(data.imageFile),
  }
}

async function localProductFromForm(data, id = newId('product')) {
  const qty = Number(data.qty)
  const lowStock = Number(data.lowStock)
  const price = resolveRequiredProductPrice(data)
  const cost = Number(data.cost)
  const profitMargin = Number(data.profitMargin)
  const conversionQuantity = Number(data.conversionQuantity ?? 1)
  const categoryName = String(data.category || '').trim()
  const matchingCategory = categoryName
    ? await adminDb.categories.filter((category) => (
      String(category.name || '').trim().toLocaleLowerCase() === categoryName.toLocaleLowerCase()
    )).first()
    : null
  return {
    id,
    sku: id,
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: categoryName,
    // An edited product can still carry the relation ID for its previous
    // category. Always derive the relation from the selected category name so
    // the queued cloud update cannot silently restore the old category.
    categoryId: matchingCategory?.id || '',
    qty: Number.isFinite(qty) ? Math.max(0, qty) : 0,
    unit: data.unit || 'Piece',
    purchaseUnit: String(data.purchaseUnit || 'Box').trim(),
    conversionQuantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    initialStock: Number(data.initialStock ?? data.qty ?? 0) || 0,
    stockUnit: String(data.stockUnit || '').trim(),
    lowStock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price,
    cost: Number.isFinite(cost) ? Math.max(0, cost) : 0,
    profitMargin: Number.isFinite(profitMargin) ? Math.max(0, profitMargin) : 0,
    image: '',
    tiers: data.tiers || [{ label: 'Retail', price: Number(data.price) || 0 }],
    sellingUnits: Array.isArray(data.sellingUnits) ? data.sellingUnits : [],
    lifecycleStatus: ['inactive', 'archived'].includes(data.lifecycleStatus) ? data.lifecycleStatus : 'active',
    status: deriveStatus(data),
    pendingSync: true,
    deleted: false,
    updated: new Date().toISOString(),
    ...await imageData(data),
  }
}

async function queueOperation(type, productId, payload) {
  const op = {
    id: newId('op'),
    type,
    productId,
    payload,
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }
  await adminDb.pendingOps.add(op)
  syncEngine?.schedule(0)
  return op
}

function enqueueInventoryScan(task) {
  const queued = inventoryScanQueue.then(task, task)
  inventoryScanQueue = queued.catch(() => {})
  return queued
}

function currentAdminUser() {
  return pb.authStore.record || adminSession || {}
}

async function recordActivity(action, detail) {
  const user = currentAdminUser()
  const recentDuplicate = await adminDb.activityLogs
    .where('time')
    .above(new Date(Date.now() - 5000).toISOString())
    .filter((log) => (
      log.userId === (user.id || '')
      && log.action === action
      && log.detail === detail
    ))
    .first()
    .catch(() => null)
  if (recentDuplicate) return recentDuplicate

  const log = {
    id: newId('log'),
    cloudId: '',
    userId: user.id || '',
    user: user.name || user.email || 'Administrator',
    userType: 'Admin',
    action,
    detail,
    time: new Date().toISOString(),
  }

  await adminDb.activityLogs.add(log)

  if (!globalThis.navigator || globalThis.navigator.onLine) {
    try {
      const record = await pb.collection('activity_logs').create({
        user_id: log.userId,
        action_type: log.action,
        description: log.detail,
        timestamp: log.time,
      }, { requestKey: log.id })
      await adminDb.activityLogs.update(log.id, { cloudId: record.id })
      return log
    } catch {
      syncEngine?.schedule(0)
    }
  } else {
    syncEngine?.schedule(0)
  }

  return log
}

async function listDesktopProducts() {
  assertAdmin()
  await startAdminRuntime()

  let localProducts = []
  try {
    localProducts = await getAllProducts()
  } catch (error) {
    if (!isIndexedDbKeyRangeError(error)) throw error
    console.warn('Unable to read the local product cache; falling back to PocketBase.', error)
  }

  if (localProducts.length > 0) {
    void refreshProductsInBackground()
    return localProducts
  }

  if (await isCloudReachable()) {
    try {
      // When online, return the cloud quantity that this request just cached.
      // Returning the old IndexedDB value while refreshing in the background
      // leaves an already-open Product Management page permanently stale.
      return await fetchCloudProducts()
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      if (localProducts.length === 0) throw error
    }
  }

  return localProducts.length > 0 ? localProducts : getAllProducts()
}

async function listDesktopStaff(role = 'cashier') {
  await startAdminRuntime()
  const staffRole = role === 'manager' ? 'manager' : 'cashier'
  if (await isCloudReachable()) {
    const [cloudRecords, salesTotals] = await Promise.all([
      pb.collection('users').getFullList({
        sort: 'name,email',
        requestKey: null,
      }),
      salesByCashier(),
    ])
    const staffRecords = cloudRecords.filter((record) => {
      const isManager = record.role === 'manager' || (record.role === 'cashier' && String(record.void_barcode || '').startsWith('92'))
      return staffRole === 'manager' ? isManager : record.role === 'cashier' && !isManager
    })
    const records = await ensureQuickLoginEmailVisibility(staffRecords)
    await cacheUsers(records)
    return records.map((record) => toCashierUser(record, salesTotals.get(record.id)))
  }

  const localUsers = (await adminDb.users.where('role').equals('cashier').toArray()).filter((user) => !user.deleted)
  const filtered = staffRole === 'manager'
    ? localUsers.filter((user) => String(user.void_barcode || user.cashierBarcode || '').startsWith('92'))
    : localUsers.filter((user) => !String(user.void_barcode || user.cashierBarcode || '').startsWith('92'))
  return filtered.map(toCashierUser)
}

async function listDesktopCashiers() {
  return listDesktopStaff('cashier')
}

export const desktopAdminApi = {
  async login(email, password) {
    requireBaseUrl()
    await startAdminRuntime()
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      return offlineLogin(email, password)
    }
    try {
      const auth = await pb.collection('users').authWithPassword(email, password)
      if (auth.record?.role !== 'admin') {
        pb.authStore.clear()
        throw new Error('Only admin accounts can access this area.')
      }
      if (auth.record?.status === 'inactive') {
        pb.authStore.clear()
        throw new Error('This account is inactive.')
      }
      await cacheAdminLogin(auth.record, password).catch(() => {})
      await recordActivity('Login', 'Signed in to admin dashboard.').catch(() => {})
      refreshAdminLocalCache({ pb }).catch(rememberPocketBaseRateLimit)
      return { user: auth.record, token: pb.authStore.token }
    } catch (error) {
      if (globalThis.navigator && !globalThis.navigator.onLine) {
        return offlineLogin(email, password)
      }
      if (error?.status === 0) return offlineLogin(email, password)
      return offlineLogin(email, password).catch(() => {
        rememberPocketBaseRateLimit(error)
        throw new Error(loginErrorMessage(error))
      })
    }
  },

  logout() {
    pb.authStore.clear()
    adminSession = null
  },

  async adminQuickLoginAccounts() {
    requireBaseUrl()
    await startAdminRuntime()
    const localRecords = await localQuickLoginUsers('admin')
    const localAccounts = localRecords.map(toSettingsUser).filter((user) => user.email)
    if (isPocketBaseRateLimited() || !(await isCloudReachable())) {
      return localAccounts
    }
    return pb.collection('users').getFullList({
      filter: 'role = "admin" && quick_login_enabled = true && status != "inactive"',
      fields: 'id,name,email,role,status',
      sort: 'name',
      requestKey: null,
    })
      .then(async (records) => {
        await cacheUsers(records.map((record) => ({
          ...record,
          quick_login_enabled: true,
        })))
        return mergeUsersById(records.map(toSettingsUser), localAccounts).filter((user) => user.email)
      })
      .catch((error) => {
        rememberPocketBaseRateLimit(error)
        return localAccounts
      })
  },

  async products() {
    return listDesktopProducts()
  },

  async categories() {
    await startAdminRuntime()
    const localCategories = (await getLocalCategories()).map((name) => ({ id: name, name }))
    if (localCategories.length > 0) {
      void refreshProductsInBackground()
      return localCategories
    }
    if (await isCloudReachable()) {
      const records = await pb.collection('categories').getFullList({
        sort: 'name',
        requestKey: null,
      }).catch(() => [])
      await adminDb.categories.bulkPut(records.map((record) => ({
        id: record.id,
        name: record.name || '',
        updated: record.updated || new Date().toISOString(),
      })))
      return records.map((record) => ({ id: record.id, name: record.name || '' }))
    }

    return localCategories
  },

  async createCategory(name) {
    await startAdminRuntime()
    const categoryName = String(name || '').trim()
    if (!categoryName) throw new Error('Category name is required.')

    if (await isCloudReachable()) {
      const existing = await pb.collection('categories').getFirstListItem(
        pb.filter('name = {:name}', { name: categoryName }),
        { requestKey: null },
      ).catch((error) => {
        if (error.status === 404) return null
        throw error
      })
      const record = existing || await pb.collection('categories').create({ name: categoryName }, { requestKey: null })
      await adminDb.categories.put({ id: record.id, name: record.name || categoryName, updated: record.updated || new Date().toISOString() })
      await recordActivity('Settings', `Created category "${record.name || categoryName}".`)
      return { id: record.id, name: record.name || categoryName }
    }

    const local = { id: `category_${categoryName.toLowerCase()}`, name: categoryName, updated: new Date().toISOString() }
    await adminDb.transaction('rw', adminDb.categories, adminDb.pendingOps, async () => {
      await adminDb.categories.put(local)
      await queueOperation('createCategory', local.id, { name: categoryName })
    })
    await recordActivity('Settings', `Created local category "${categoryName}".`)
    return local
  },

  async createProduct(data) {
    assertAdmin()
    await startAdminRuntime()
    const product = await localProductFromForm(data)
    const existing = product.barcode ? await getProductByBarcode(product.barcode) : null
    if (existing && !existing.deleted) {
      throw new Error(`Barcode ${product.barcode} already belongs to "${existing.name}". Edit that product instead of adding a duplicate.`)
    }

    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      if (existing?.deleted) await adminDb.products.delete(existing.id)
      await adminDb.products.put(product)
      await queueOperation('createProduct', product.id, product)
    })
    await recordActivity('Product', `Created product "${product.name}".`)
    syncEngine?.syncNow().catch(rememberPocketBaseRateLimit)
    return product
  },

  async updateProduct(id, data) {
    assertAdmin()
    await startAdminRuntime()
    const existing = await adminDb.products.get(id)
    const product = {
      ...existing,
      ...await localProductFromForm(data, id),
      pendingSync: true,
      updated: new Date().toISOString(),
    }
    const barcodeOwner = product.barcode ? await getProductByBarcode(product.barcode) : null
    if (barcodeOwner && barcodeOwner.id !== id) {
      throw new Error(`Barcode ${product.barcode} already belongs to "${barcodeOwner.name}". Choose a different barcode.`)
    }
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      await adminDb.products.put(product)
      await queueOperation('updateProduct', id, product)
    })
    await recordActivity('Product', `Updated product "${product.name}".`)
    syncEngine?.syncNow().catch(rememberPocketBaseRateLimit)
    return product
  },

  async deleteProduct(id) {
    assertAdmin()
    await startAdminRuntime()
    let deletedName = ''
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      const existing = await adminDb.products.get(id)
      if (existing) {
        deletedName = existing.name
        await adminDb.products.put({ ...existing, deleted: true, pendingSync: true })
      }
      await queueOperation('deleteProduct', id, { id })
    })
    if (deletedName) await recordActivity('Product', `Deleted product "${deletedName}".`)
    syncEngine?.syncNow().catch(rememberPocketBaseRateLimit)
    return null
  },

  async scanInventory({ barcode, productId = '', unitConversion = 1, unitLabel = '', qty = 1 }) {
    return enqueueInventoryScan(async () => {
      assertAdmin()
      await startAdminRuntime()
      const stockInQty = Math.max(1, Number(qty) || 1)
      let product = productId ? await adminDb.products.get(productId).catch(() => null) : await getProductByBarcode(barcode)
      if (!product && (await isCloudReachable())) {
        await refreshAdminLocalCache({ pb })
        product = productId ? await adminDb.products.get(productId).catch(() => null) : await getProductByBarcode(barcode)
      }
      if (!product) throw new Error(barcode ? `No product found for barcode "${barcode}".` : 'No product found.')

      const matchingUnit = Array.isArray(product?.sellingUnits)
        ? product.sellingUnits.find((unit) => String(unit?.barcode || '').trim() === barcode)
        : null
      const requestedConversion = Number(unitConversion)
      const conversion = Number(matchingUnit?.conversion) > 0
        ? Number(matchingUnit.conversion)
        : (Number.isFinite(requestedConversion) && requestedConversion > 0 ? requestedConversion : 1)

      let updated
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        const currentProduct = await adminDb.products.get(product.id)
        if (!currentProduct || currentProduct.deleted) {
          throw new Error(`No product found for barcode "${barcode}".`)
        }

        updated = {
          ...currentProduct,
          qty: Number(currentProduct.qty) + (stockInQty * conversion),
          pendingSync: true,
          updated: new Date().toISOString(),
        }
        updated.status = deriveStatus(updated)
        await adminDb.products.put(updated)
        await queueOperation('scanInventory', updated.id, {
          id: updated.id,
          barcode,
          qty: stockInQty * conversion,
        })
      })
      await recordActivity('Stock Update', `Added ${stockInQty} ${unitLabel || updated.unit || 'unit(s)'} to "${updated.name}".`)
      return updated
    })
  },

  async stockOutInventory({ barcode, productId = '', unitConversion = 1, unitLabel = '', qty = 1, reason = 'other', note = '' }) {
    return enqueueInventoryScan(async () => {
      assertAdmin()
      await startAdminRuntime()
      const stockOutQty = Math.max(1, Number(qty) || 1)
      let product = productId ? await adminDb.products.get(productId).catch(() => null) : await getProductByBarcode(barcode)
      if (!product && (await isCloudReachable())) {
        await refreshAdminLocalCache({ pb })
        product = productId ? await adminDb.products.get(productId).catch(() => null) : await getProductByBarcode(barcode)
      }
      if (!product) throw new Error(barcode ? `No product found for barcode "${barcode}".` : 'No product found.')

      const matchingUnit = Array.isArray(product?.sellingUnits)
        ? product.sellingUnits.find((unit) => String(unit?.barcode || '').trim() === barcode)
        : null
      const requestedConversion = Number(unitConversion)
      const conversion = Number(matchingUnit?.conversion) > 0
        ? Number(matchingUnit.conversion)
        : (Number.isFinite(requestedConversion) && requestedConversion > 0 ? requestedConversion : 1)
      const baseUnitsToRemove = stockOutQty * conversion

      let updated
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        const currentProduct = await adminDb.products.get(product.id)
        if (!currentProduct || currentProduct.deleted) {
          throw new Error(`No product found for barcode "${barcode}".`)
        }
        if ((Number(currentProduct.qty) || 0) < baseUnitsToRemove) {
          throw new Error(`"${currentProduct.name}" has only ${currentProduct.qty || 0} base unit(s) in stock.`)
        }

        updated = {
          ...currentProduct,
          qty: Math.max(0, Number(currentProduct.qty) - baseUnitsToRemove),
          pendingSync: true,
          updated: new Date().toISOString(),
        }
        updated.status = deriveStatus(updated)
        await adminDb.products.put(updated)
        await queueOperation('stockOutInventory', updated.id, {
          id: updated.id,
          barcode,
          qty: baseUnitsToRemove,
          reason,
          note,
        })
      })
      await recordActivity('Stock Out', `Removed ${stockOutQty} ${unitLabel || updated.unit || 'unit(s)'} from "${updated.name}" - ${reason}${note ? ` (${note})` : ''}.`)
      return updated
    })
  },

  async adjustInventoryCount({ productId, countedQty, reason, note = '' }) {
    assertAdmin()
    await startAdminRuntime()
    const normalizedReason = String(reason || '').trim()
    if (!normalizedReason) throw new Error('An adjustment reason is required.')
    const actual = Number(countedQty)
    if (!Number.isFinite(actual) || actual < 0) throw new Error('Physical count must be zero or greater.')

    let updated
    let previousQty
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      const product = await adminDb.products.get(productId)
      if (!product || product.deleted) throw new Error('Product was not found in the local catalog.')
      previousQty = Number(product.qty) || 0
      const delta = actual - previousQty
      if (!delta) throw new Error('Physical count already matches system stock.')
      updated = { ...product, qty: actual, pendingSync: true, updated: new Date().toISOString() }
      updated.status = deriveStatus(updated)
      await adminDb.products.put(updated)
      await queueOperation('adjustInventoryCount', product.id, {
        id: product.id,
        barcode: product.barcode,
        name: product.name,
        previousQty,
        countedQty: actual,
        delta,
        reason: normalizedReason,
        note: String(note || '').trim(),
      })
    })
    await recordActivity('Inventory Adjustment', `Adjusted "${updated.name}" from ${previousQty} to ${actual} (${normalizedReason})${note ? ` - ${note}` : ''}.`)
    return updated
  },

  async fsnInventory() {
    const products = await listDesktopProducts()
    const localCompletedSales = await localCashierCompletedSales()
    let cloudSales = []
    let cloudSaleItems = []

    if (await isCloudReachable()) {
      ;[cloudSales, cloudSaleItems] = await Promise.all([
        pb.collection('sales').getFullList({
          requestKey: null,
        }).catch(() => []),
        pb.collection('sale_items').getFullList({
          expand: 'product_id',
          requestKey: null,
        }).catch(() => []),
      ])
    }

    const productLookup = buildProductLookup(products)
    const cloudSaleById = new Map(cloudSales.map((sale) => [sale.id, sale]))
    const cloudProductIdsByTransactionNo = new Map()
    for (const item of cloudSaleItems) {
      const sale = cloudSaleById.get(firstRelation(item.sale_id ?? item.saleId))
      const transactionNo = sale?.transaction_no || sale?.transactionNo
      if (!transactionNo) continue
      const product = resolveSaleItemProduct(item, productLookup)
      const productId = product?.id || firstRelation(item.product_id ?? item.productId)
      if (!productId) continue
      const productIds = cloudProductIdsByTransactionNo.get(transactionNo) || new Set()
      productIds.add(String(productId))
      cloudProductIdsByTransactionNo.set(transactionNo, productIds)
    }
    const cloudTransactionNos = new Set(cloudSales.map((sale) => sale.transaction_no || sale.transactionNo).filter(Boolean))
    const localSalesForMovement = []
    const localItems = []
    for (const sale of localCompletedSales) {
      const localItemsForSale = localSaleItems(sale)
      const cloudProductIds = cloudProductIdsByTransactionNo.get(sale.transactionNo) || new Set()
      const includeWholeSale = !cloudTransactionNos.has(sale.transactionNo)
        || ['adjusted', 'voided'].includes(sale.status)
      const missingItems = includeWholeSale
        ? localItemsForSale
        : localItemsForSale.filter((item) => {
          const product = resolveSaleItemProduct(item, productLookup)
          const productId = product?.id || firstRelation(item.product_id ?? item.productId)
          return productId && !cloudProductIds.has(String(productId))
        })

      if (missingItems.length) {
        localSalesForMovement.push(sale)
        localItems.push(...missingItems)
      }
    }
    const localSales = localSalesForMovement.map(localSaleAsCloudLike)
    const salesById = new Map()
    for (const sale of cloudSales) salesById.set(sale.id, sale)
    for (const sale of localSales) salesById.set(sale.id, sale)

    const saleItems = [...cloudSaleItems, ...localItems]
    const metrics = buildFsnMetrics(products, [...salesById.values()], saleItems, new Date())
    return products.map((product) => classifyFsnProduct(product, metrics.get(product.id), new Date()))
  },

  async nextProductBarcode() {
    return { barcode: `29${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 10)}` }
  },

  async dashboard(options = {}) {
    await startAdminRuntime()
    const localCompletedSales = await localCashierCompletedSales()
    if (!options.preferCloud) {
      const products = await listDesktopProducts()
      const localSales = localCompletedSales.map(localSaleAsCloudLike)
      const localItems = localCompletedSales.flatMap(localSaleItems)
      return buildDashboardFromRecords(products, localSales, localItems, new Date(), options)
    }
    if (!(await isCloudReachable())) {
      const products = await listDesktopProducts()
      const localSales = localCompletedSales.map(localSaleAsCloudLike)
      const localItems = localCompletedSales.flatMap(localSaleItems)
      return buildDashboardFromRecords(products, localSales, localItems, new Date(), options)
    }

    await refreshAdminLocalCache({ pb }).catch(() => {})
    const products = await getAllProducts()
    const [cloudSales, cloudSaleItems] = await Promise.all([
      pb.collection('sales').getFullList({
        requestKey: null,
      }).catch(() => []),
      pb.collection('sale_items').getFullList({
        expand: 'product_id',
        requestKey: null,
      }).catch(() => []),
    ])

    const overriddenTransactionNos = new Set(
      localCompletedSales
        .filter((sale) => ['adjusted', 'voided'].includes(sale.status))
        .map((sale) => sale.transactionNo)
        .filter(Boolean),
    )
    const cloudTransactionNos = new Set(cloudSales.map((sale) => sale.transaction_no || sale.transactionNo).filter(Boolean))
    const localSalesForDashboard = localCompletedSales.filter((sale) => (
      !cloudTransactionNos.has(sale.transactionNo) || overriddenTransactionNos.has(sale.transactionNo)
    ))
    const sales = [
      ...cloudSales.filter((sale) => !overriddenTransactionNos.has(sale.transaction_no || sale.transactionNo)),
      ...localSalesForDashboard.map(localSaleAsCloudLike),
    ]
    const saleItems = [
      ...cloudSaleItems,
      ...localSalesForDashboard.flatMap(localSaleItems),
    ]

    return buildDashboardFromRecords(products, sales, saleItems, new Date(), options)
  },
  async syncNow() {
    await startAdminRuntime()
    await initializeCashierDb()
    await adminDb.pendingOps.where('status').equals('failed').modify({
      status: 'pending',
      nextAttemptAt: 0,
    })
    await adminDb.pendingOps.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    await cashierDb.pendingSales.where('status').equals('failed').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 })
    await cashierDb.pendingSales.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    await cashierDb.pendingOps.where('status').equals('failed').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 })
    await cashierDb.pendingOps.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    const cashierQueueSync = new CashierSyncEngine({ pb })
    // A newly constructed cashier engine is stopped by default. Start the
    // one-shot engine so its sale and operation upload loops actually run.
    cashierQueueSync.start()
    try {
      const [adminResult, cashierResult] = await Promise.all([
        syncEngine?.syncNow({ forceNetworkCheck: true }) || { uploaded: 0, failed: 0, errors: [], pending: 0 },
        cashierQueueSync.syncNow({ forceNetworkCheck: true }),
      ])
      // The admin engine may have pulled products just before the cashier
      // engine uploaded an offline sale. Pull once more after both finish so
      // the shared admin cache contains the post-sale stock quantity.
      await refreshAdminLocalCache({ pb }).catch(rememberPocketBaseRateLimit)
      return {
        uploaded: (adminResult.uploaded || 0) + (cashierResult.uploaded || 0),
        failed: (adminResult.failed || 0) + (cashierResult.failed || 0),
        errors: [...(adminResult.errors || []), ...(cashierResult.errors || [])],
        warnings: [...(adminResult.warnings || []), ...(cashierResult.warnings || [])],
        pending: await adminDb.pendingOps.count() + await cashierDb.pendingOps.count() + await cashierDb.pendingSales.count(),
      }
    } finally {
      cashierQueueSync.stop()
    }
  },
  async syncQueueDetails() {
    await startAdminRuntime()
    await initializeCashierDb()
    const [adminOps, cashierOps, cashierSales] = await Promise.all([
      adminDb.pendingOps.orderBy('createdAt').reverse().toArray(),
      cashierDb.pendingOps.orderBy('createdAt').reverse().toArray(),
      cashierDb.pendingSales.orderBy('createdAt').reverse().toArray(),
    ])
    reconcileAdminSyncStatus(adminOps)
    return [
      ...adminOps.map((op) => ({ ...op, source: 'Admin', queueKind: 'adminOperation' })),
      ...cashierOps.map((op) => ({ ...op, source: 'Cashier', queueKind: 'cashierOperation', payload: op.payload || {} })),
      ...cashierSales.map((sale) => ({
        ...sale,
        id: sale.clientSaleId,
        type: 'sale',
        source: 'Cashier',
        queueKind: 'cashierSale',
        payload: {
          name: sale.transactionNo,
          barcode: sale.items?.map((item) => item.barcode).filter(Boolean).join(', '),
        },
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  },
  async discardFailedProductSync(id) {
    await startAdminRuntime()
    await initializeCashierDb()
    const operation = await adminDb.pendingOps.get(id)
    const productTypes = new Set(['createProduct', 'updateProduct', 'deleteProduct'])
    if (!operation || operation.status !== 'failed' || !productTypes.has(operation.type)) {
      throw new Error('The failed product change was not found or is not safe to discard.')
    }

    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      const related = await adminDb.pendingOps.where('productId').equals(operation.productId).toArray()
      const failedRelatedIds = related.filter((item) => item.status === 'failed' && productTypes.has(item.type)).map((item) => item.id)
      await adminDb.pendingOps.bulkDelete(failedRelatedIds)
      await adminDb.products.delete(operation.productId)
    })
    await cashierDb.products.delete(operation.productId).catch(() => {})
    reconcileAdminSyncStatus(await adminDb.pendingOps.toArray(), { force: true })
    return { discarded: true, productId: operation.productId }
  },
  async discardAllFailedProductSync() {
    await startAdminRuntime()
    await initializeCashierDb()
    const productTypes = new Set(['createProduct', 'updateProduct', 'deleteProduct'])
    const failed = (await adminDb.pendingOps.where('status').equals('failed').toArray())
      .filter((operation) => productTypes.has(operation.type))
    const productIds = [...new Set(failed.map((operation) => operation.productId).filter(Boolean))]
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      await adminDb.pendingOps.bulkDelete(failed.map((operation) => operation.id))
      await adminDb.products.bulkDelete(productIds)
    })
    await cashierDb.products.bulkDelete(productIds).catch(() => {})
    reconcileAdminSyncStatus(await adminDb.pendingOps.toArray(), { force: true })
    return { discarded: failed.length, productsRemoved: productIds.length }
  },
  async resolveSyncConflict(id, resolution = 'cloud', mergedFields = {}) {
    await startAdminRuntime()
    const op = await adminDb.pendingOps.get(id)
    if (!op || op.status !== 'conflict' || !op.conflict) throw new Error('Sync conflict was not found.')
    const localProduct = await adminDb.products.get(op.productId)

    if (resolution === 'cloud') {
      const cloud = op.conflict.cloud
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        await adminDb.products.put({
          ...localProduct,
          ...cloud,
          qty: Number(localProduct?.qty ?? cloud.qty) || 0,
          pendingSync: false,
          status: deriveStatus({ ...cloud, qty: Number(localProduct?.qty ?? cloud.qty) || 0 }),
        })
        await adminDb.pendingOps.delete(id)
      })
      return { resolved: true, resolution }
    }

    const payload = resolution === 'fields'
      ? { ...op.payload, ...mergedFields, forceConflictResolution: true }
      : { ...op.payload, forceConflictResolution: true }
    await adminDb.pendingOps.update(id, {
      payload,
      status: 'pending',
      conflict: null,
      attempts: 0,
      lastError: '',
      nextAttemptAt: 0,
    })
    void syncEngine?.syncNow()
    return { resolved: true, resolution }
  },
  async offlineReadiness() {
    await startAdminRuntime()
    await initializeCashierDb()
    const [products, cashierProducts, categories, users, authorizationBarcodes, adminPending, adminFailed, pendingSales, cashierPending, cashierFailed, receipts, cashierSettings] = await Promise.all([
      adminDb.products.filter((product) => !product.deleted).count(),
      cashierDb.products.count(),
      adminDb.categories.count(),
      adminDb.users.filter((user) => !user.deleted && user.status !== 'inactive').count(),
      adminDb.authorizationBarcodes.filter((record) => !record.deleted && record.status === 'active').count(),
      adminDb.pendingOps.where('status').equals('pending').count(),
      adminDb.pendingOps.where('status').equals('failed').count(),
      cashierDb.pendingSales.count(),
      cashierDb.pendingOps.where('status').equals('pending').count(),
      cashierDb.pendingOps.where('status').equals('failed').count(),
      cashierDb.receiptCache.count(),
      cashierDb.settings.toArray(),
    ])
    const offlineCashierPasswordLogins = cashierSettings.filter((item) => String(item.key).startsWith('cashierLogin:')).length
    const offlineCashierBarcodeLogins = await adminDb.users.filter((user) => (
      user.role === 'cashier'
      && user.status !== 'inactive'
      && !user.deleted
      && Boolean(String(user.cashierBarcode || user.void_barcode || '').trim())
      && !String(user.cashierBarcode || user.void_barcode || '').startsWith('92')
    )).count()
    const offlineCashierLogins = offlineCashierPasswordLogins + offlineCashierBarcodeLogins
    const offlineManagerPasswords = cashierSettings.filter((item) => String(item.key).startsWith('managerApproval:')).length
    const managerBarcodes = await adminDb.users.filter((user) => String(user.void_barcode || user.cashierBarcode || '').startsWith('92') && user.status !== 'inactive').count()
    const pending = adminPending + pendingSales + cashierPending
    const failed = adminFailed + cashierFailed
    const [failedAdminOps, failedCashierOps, failedCashierSales] = await Promise.all([
      adminDb.pendingOps.where('status').equals('failed').toArray(),
      cashierDb.pendingOps.where('status').equals('failed').toArray(),
      cashierDb.pendingSales.where('status').equals('failed').toArray(),
    ])
    const failedDetails = [
      ...failedAdminOps.map((operation) => ({ ...operation, source: 'Admin' })),
      ...failedCashierOps.map((operation) => ({ ...operation, source: 'Cashier' })),
      ...failedCashierSales.map((operation) => ({ ...operation, source: 'Cashier', type: 'sale' })),
    ].map((operation) => ({
        id: operation.id,
        source: operation.source,
        type: operation.type,
        record: operation.payload?.name || operation.transactionNo || operation.payload?.barcode || operation.id,
        error: operation.lastError || 'Unknown synchronization error.',
      }))
    const lastAdminSync = JSON.parse(localStorage.getItem('nexa_sync_status_admin') || 'null')
    const lastCashierSync = JSON.parse(localStorage.getItem('nexa_sync_status_cashier') || 'null')
    return {
      ready: products > 0 && cashierProducts > 0 && categories > 0 && users > 0 && offlineCashierLogins > 0 && (authorizationBarcodes + managerBarcodes + offlineManagerPasswords) > 0 && failed === 0,
      terminalId: getTerminalId(),
      terminalName: getTerminalName(),
      products,
      cashierProducts,
      categories,
      users,
      authorizationBarcodes,
      managerApprovals: authorizationBarcodes + managerBarcodes + offlineManagerPasswords,
      offlineCashierLogins,
      offlineCashierPasswordLogins,
      offlineCashierBarcodeLogins,
      receipts,
      pending,
      failed,
      failedDetails,
      lastDownloadAt: [lastAdminSync?.updatedAt, lastCashierSync?.updatedAt].filter(Boolean).sort().at(-1) || '',
    }
  },
  async downloadOfflineData() {
    if (!pb.authStore.isValid || pb.authStore.record?.role !== 'admin') {
      throw new Error('An online admin login is required to download offline data. Connect this PC to the internet, log out, and sign in again before retrying.')
    }
    await this.syncNow()
    try {
      const catalog = await refreshAdminLocalCache({ pb, requireCatalog: true })
      const staff = await pb.collection('users').getFullList({
        filter: 'status != "inactive"',
        sort: 'name,email',
        requestKey: null,
      })
      if (staff.length === 0) {
        throw new Error('The cloud returned zero staff accounts. Check the users collection list rule and confirm this terminal is connected to the correct PocketBase database.')
      }
      await cacheUsers(await ensureQuickLoginEmailVisibility(staff))
      await this.authorizationBarcodes()
      await copyAdminProductCatalogToCashier()
      const readiness = await this.offlineReadiness()
      if (readiness.products === 0 || readiness.cashierProducts === 0 || readiness.categories === 0 || readiness.users === 0) {
        throw new Error(`Cloud data was received but the local cache is incomplete (${catalog.products} products and ${catalog.categories} categories received). Close other Nexa POS windows on this PC and try again.`)
      }
      return readiness
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      throw new Error(`Unable to prepare this PC for offline use: ${error?.message || 'Cloud request failed.'}`, { cause: error })
    }
  },
  async resetLocalData({ scope = 'full', confirmation = '' } = {}) {
    assertAdmin()
    await startAdminRuntime()
    await initializeCashierDb()
    if (confirmation !== 'RESET TERMINAL') throw new Error('Reset confirmation did not match RESET TERMINAL.')

    const [adminQueue, cashierOperations, cashierSales] = await Promise.all([
      adminDb.pendingOps.count(),
      cashierDb.pendingOps.count(),
      cashierDb.pendingSales.count(),
    ])
    const queued = adminQueue + cashierOperations + cashierSales
    if (queued > 0) throw new Error(`Cannot reset local data while ${queued} change(s) are waiting, failed, or conflicting. Synchronize or resolve them first.`)

    const allowedScopes = new Set(['catalog', 'logins', 'receipts', 'sync-status', 'full'])
    if (!allowedScopes.has(scope)) throw new Error('Unknown local-data reset option.')
    await recordActivity('Settings', `Reset local terminal data (${scope}) on ${getTerminalName()}.`)

    if (scope === 'catalog' || scope === 'full') {
      await Promise.all([
        adminDb.transaction('rw', adminDb.products, adminDb.categories, async () => {
          await adminDb.products.clear()
          await adminDb.categories.clear()
        }),
        cashierDb.products.clear(),
      ])
    }
    if (scope === 'logins' || scope === 'full') {
      await adminDb.users.filter((user) => user.role !== 'admin').delete()
      await cashierDb.quickLoginAccounts.clear()
      const credentialKeys = (await cashierDb.settings.toArray())
        .filter((item) => /^(cashierLogin:|cashierSyncAuth:|managerApproval:)/.test(String(item.key)))
        .map((item) => item.key)
      await cashierDb.settings.bulkDelete(credentialKeys)
    }
    if (scope === 'receipts' || scope === 'full') {
      await Promise.all([cashierDb.receiptCache.clear(), cashierDb.completedSales.clear()])
    }
    if (scope === 'sync-status' || scope === 'full') {
      for (const key of ['nexa_sync_status_admin', 'nexa_sync_status_cashier', 'nexa_offline_self_test']) {
        globalThis.localStorage?.removeItem(key)
      }
    }
    if (scope === 'full') {
      await Promise.all([
        adminDb.authorizationBarcodes.clear(),
        adminDb.supportTickets.clear(),
      ])
    }

    const shouldRefresh = ['catalog', 'logins', 'full'].includes(scope)
      && (!globalThis.navigator || globalThis.navigator.onLine)
    if (shouldRefresh) await this.downloadOfflineData()
    return { scope, refreshed: shouldRefresh, readiness: await this.offlineReadiness() }
  },
  async offlineSelfTest() {
    await startAdminRuntime()
    await initializeCashierDb()
    const readiness = await this.offlineReadiness()
    const probeKey = `offlineSelfTest:${Date.now()}`
    let localWritePassed
    try {
      await Promise.all([
        adminDb.settings.put({ key: probeKey, value: 'ok' }),
        cashierDb.settings.put({ key: probeKey, value: 'ok' }),
      ])
      const [adminProbe, cashierProbe] = await Promise.all([adminDb.settings.get(probeKey), cashierDb.settings.get(probeKey)])
      localWritePassed = adminProbe?.value === 'ok' && cashierProbe?.value === 'ok'
    } finally {
      await Promise.all([adminDb.settings.delete(probeKey), cashierDb.settings.delete(probeKey)]).catch(() => {})
    }
    const checks = [
      { key: 'storage', label: 'Local database read and write', passed: localWritePassed, detail: localWritePassed ? 'IndexedDB is writable.' : 'Local storage could not be written.' },
      { key: 'adminCatalog', label: 'Admin product catalog', passed: readiness.products > 0, detail: `${readiness.products} products available locally.` },
      { key: 'cashierCatalog', label: 'Cashier product catalog', passed: readiness.cashierProducts > 0, detail: `${readiness.cashierProducts} products available at checkout.` },
      { key: 'staff', label: 'Staff accounts', passed: readiness.users > 0, detail: `${readiness.users} active accounts cached.` },
      { key: 'cashierLogin', label: 'Offline cashier login', passed: readiness.offlineCashierLogins > 0, detail: `${readiness.offlineCashierBarcodeLogins || 0} barcode and ${readiness.offlineCashierPasswordLogins || 0} password login profile(s) cached.` },
      { key: 'approval', label: 'Manager approval', passed: readiness.managerApprovals > 0, detail: `${readiness.managerApprovals} approval methods cached.` },
      { key: 'queue', label: 'Sync queue integrity', passed: readiness.failed === 0, detail: readiness.failed ? `${readiness.failed} failed operations need attention.` : `${readiness.pending} changes can safely wait for sync.` },
    ]
    return { passed: checks.every((check) => check.passed), testedAt: new Date().toISOString(), checks }
  },
  async maintenanceReport() {
    await startAdminRuntime()
    await initializeCashierDb()
    const [products, receipts] = await Promise.all([
      adminDb.products.filter((product) => !product.deleted).toArray(),
      cashierDb.receiptCache.toArray(),
    ])
    const barcodeGroups = new Map()
    for (const product of products) {
      const barcode = String(product.barcode || '').trim()
      if (!barcode) continue
      barcodeGroups.set(barcode, [...(barcodeGroups.get(barcode) || []), product])
    }
    const productIds = new Set(products.map((product) => product.id))
    const receiptItems = receipts.flatMap((receipt) => receipt.items || receipt.value?.items || [])
    return {
      checkedAt: new Date().toISOString(),
      source: 'Local terminal cache',
      products: products.length,
      duplicateBarcodes: [...barcodeGroups.entries()]
        .filter(([, records]) => records.length > 1)
        .map(([barcode, records]) => ({ barcode, count: records.length, products: records.map((record) => record.name) })),
      invalidPrices: products.filter((product) => !Number.isFinite(Number(product.price)) || Number(product.price) <= 0).map((product) => ({ id: product.id, name: product.name })),
      invalidStock: products.filter((product) => !Number.isFinite(Number(product.qty)) || Number(product.qty) < 0).map((product) => ({ id: product.id, name: product.name })),
      uncategorized: products.filter((product) => !String(product.category || product.categoryId || '').trim()).map((product) => ({ id: product.id, name: product.name })),
      orphanSaleItems: receiptItems.filter((item) => item.productId && !productIds.has(item.productId)).length,
    }
  },
  async latestAuthorizationBarcode() {
    await startAdminRuntime()
    if (!(await isCloudReachable())) return null

    const records = await pb.collection('authorization_barcodes').getFullList({
      sort: '-created',
      filter: 'status = "active"',
      expand: 'generated_by',
      requestKey: null,
    }).catch(() => [])

    return records[0] ? toAuthorizationBarcode(records[0]) : null
  },
  async authorizationBarcodes() {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      return adminDb.authorizationBarcodes.filter((record) => !record.deleted).reverse().sortBy('createdAt')
    }

    const records = await pb.collection('authorization_barcodes').getFullList({
      sort: '-created',
      expand: 'generated_by',
      requestKey: null,
    }).catch(() => [])

    const normalized = records.map((record) => ({
      ...toAuthorizationBarcode(record),
      generatedById: firstRelation(record.generated_by) || '',
      generatedByEmail: record.expand?.generated_by?.email || '',
      pendingSync: false,
    }))
    await adminDb.transaction('rw', adminDb.authorizationBarcodes, async () => {
      const pending = await adminDb.authorizationBarcodes.filter((record) => record.pendingSync).toArray()
      await adminDb.authorizationBarcodes.clear()
      await adminDb.authorizationBarcodes.bulkPut([...normalized, ...pending])
    })
    return normalized
  },
  async updateAuthorizationBarcodeStatus(id, status) {
    await startAdminRuntime()
    const nextStatus = status === 'revoked' ? 'revoked' : 'active'
    if (!(await isCloudReachable())) {
      const existing = await adminDb.authorizationBarcodes.get(id)
      const updated = { ...existing, status: nextStatus, pendingSync: true }
      await adminDb.transaction('rw', adminDb.authorizationBarcodes, adminDb.pendingOps, async () => {
        await adminDb.authorizationBarcodes.put(updated)
        await queueOperation('updateAuthorizationBarcode', id, { status: nextStatus })
      })
      return updated
    }
    const updated = await pb.collection('authorization_barcodes').update(id, {
      status: nextStatus,
    }, {
      expand: 'generated_by',
      requestKey: null,
    }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to update authorization barcode.'))
    })

    await adminDb.authorizationBarcodes.put({
      ...toAuthorizationBarcode(updated),
      generatedById: firstRelation(updated.generated_by) || '',
      generatedByEmail: updated.expand?.generated_by?.email || '',
      pendingSync: false,
    })
    await recordActivity('Settings', `${nextStatus === 'active' ? 'Enabled' : 'Disabled'} authorization barcode ${updated.code}.`)
    return toAuthorizationBarcode(updated)
  },
  async deleteAuthorizationBarcode(id) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      const existing = await adminDb.authorizationBarcodes.get(id)
      await adminDb.transaction('rw', adminDb.authorizationBarcodes, adminDb.pendingOps, async () => {
        if (existing) await adminDb.authorizationBarcodes.put({ ...existing, deleted: true, pendingSync: true })
        await queueOperation('deleteAuthorizationBarcode', id, {})
      })
      return null
    }

    await pb.collection('authorization_barcodes').delete(id, { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to delete authorization barcode.'))
    })
    await adminDb.authorizationBarcodes.delete(id)
    await recordActivity('Settings', `Deleted authorization barcode ${id}.`)
    return null
  },
  async cashiers() {
    return listDesktopCashiers()
  },
  async staff(role = 'cashier') {
    return listDesktopStaff(role)
  },
  receipts: fetchReceiptRecords,
  async createCashier(data) {
    await startAdminRuntime()
    const roleLabel = String(data?.role || '').trim() === 'manager' ? 'manager' : 'cashier'
    if (!(await isCloudReachable())) {
      const payload = cashierPayload(data)
      if (data.imageFile) {
        payload.profileImage = data.imageFile
        payload.profileImageName = data.imageFile.name
      }
      const local = {
        id: newId('staff'),
        ...payload,
        cashierBarcode: payload.void_barcode || '',
        pendingSync: true,
        updated: new Date().toISOString(),
      }
      await adminDb.transaction('rw', adminDb.users, adminDb.pendingOps, async () => {
        await adminDb.users.put(local)
        await queueOperation('createStaff', local.id, payload)
      })
      await recordActivity(roleLabel === 'manager' ? 'Manager' : 'Cashier', `Created ${roleLabel} "${local.name || local.email}" offline.`)
      return toCashierUser(local)
    }
    const created = await pb.collection('users').create(cashierBody(data), { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, `Unable to create ${roleLabel}.`))
    })
    await cacheUsers([created])
    await recordActivity(roleLabel === 'manager' ? 'Manager' : 'Cashier', `Created ${roleLabel} "${created.name || created.email}".`)
    return toCashierUser(created)
  },
  async createStaff(data) {
    return this.createCashier(data)
  },
  async updateCashier(id, data) {
    await startAdminRuntime()
    const staffId = String(id || data?.id || data?.cashierId || '').trim()
    if (!staffId) throw new Error('Unable to save this staff account because its ID is missing. Refresh Staff Management and try again.')
    const roleLabel = String(data?.role || '').trim() === 'manager' ? 'manager' : 'cashier'
    if (!(await isCloudReachable())) {
      const existing = await adminDb.users.get(staffId)
      const payload = cashierPayload(data)
      delete payload.email
      delete payload.password
      delete payload.passwordConfirm
      if (data.imageFile) {
        payload.profileImage = data.imageFile
        payload.profileImageName = data.imageFile.name
      }
      const local = { ...existing, ...payload, id: staffId, cashierBarcode: payload.void_barcode || existing?.cashierBarcode || '', pendingSync: true, updated: new Date().toISOString() }
      await adminDb.transaction('rw', adminDb.users, adminDb.pendingOps, async () => {
        await adminDb.users.put(local)
        await queueOperation('updateStaff', staffId, payload)
      })
      await recordActivity(roleLabel === 'manager' ? 'Manager' : 'Cashier', `Updated ${roleLabel} "${local.name || local.email}" offline.`)
      return toCashierUser(local)
    }
    const body = cashierUpdateBody(data)
    const updated = await pb.collection('users').update(staffId, body, { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, `Unable to update ${roleLabel}.`))
    })
    await cacheUsers([updated])
    await recordActivity(roleLabel === 'manager' ? 'Manager' : 'Cashier', `Updated ${roleLabel} "${updated.name || updated.email}".`)
    return toCashierUser(updated)
  },
  async updateStaff(id, data) {
    return this.updateCashier(id, data)
  },
  async deleteCashier(id) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      const existing = await adminDb.users.get(id)
      await adminDb.transaction('rw', adminDb.users, adminDb.pendingOps, async () => {
        if (existing) await adminDb.users.put({ ...existing, deleted: true, pendingSync: true })
        await queueOperation('deleteStaff', id, {})
      })
      await recordActivity('Cashier', 'Deleted cashier account offline.')
      return null
    }
    await pb.collection('users').delete(id, { requestKey: null }).catch((error) => {
      // Another terminal may have removed this account after this screen loaded.
      // A missing cloud record means the requested end state is already reached.
      if (Number(error?.status || error?.response?.status) !== 404) throw error
    })
    await adminDb.users.delete(id)
    await recordActivity('Cashier', 'Deleted cashier account.')
    return null
  },
  async deleteStaff(id) {
    return this.deleteCashier(id)
  },
  async activityLogs() {
    await startAdminRuntime()
    const localLogs = await adminDb.activityLogs.orderBy('time').reverse().toArray()
    if (await isCloudReachable()) {
      let records
      try {
        records = await pb.collection('activity_logs').getFullList({
          sort: '-timestamp,-created',
          expand: 'user_id',
          requestKey: null,
        })
      } catch {
        return localLogs
      }
      const logs = records.map(toCloudActivityLog)
      const cloudIds = new Set(logs.map((log) => String(log.cloudId || '')).filter(Boolean))
      await adminDb.activityLogs
        .filter((log) => Boolean(log.cloudId) && !cloudIds.has(String(log.cloudId)))
        .delete()
      if (logs.length) await adminDb.activityLogs.bulkPut(logs)

      const merged = new Map()
      const retainedLocalLogs = localLogs.filter((log) => !log.cloudId || cloudIds.has(String(log.cloudId)))
      for (const log of [...logs, ...retainedLocalLogs]) {
        const key = log.cloudId || log.id
        if (!merged.has(key)) merged.set(key, log)
      }
      const deduped = new Map()
      for (const log of [...merged.values()].sort((a, b) => new Date(a.time) - new Date(b.time))) {
        const bucket = Math.floor(new Date(log.time).getTime() / 5000)
        const signature = [log.userId || log.user, log.action, log.detail, bucket].join('|')
        if (!deduped.has(signature)) deduped.set(signature, log)
      }
      return [...deduped.values()].sort((a, b) => new Date(b.time) - new Date(a.time))
    }

    return localLogs
  },
  async markAuditReviewed(data = {}) {
    await startAdminRuntime()
    const reviewedBy = adminSession?.id || pb.authStore.record?.id || ''
    if (!reviewedBy) return null
    const payload = {
      reviewed_by: reviewedBy,
      date_from: data.fromDate ? `${data.fromDate}T00:00:00.000Z` : new Date().toISOString(),
      date_to: data.toDate ? `${data.toDate}T23:59:59.999Z` : new Date().toISOString(),
      row_count: Math.max(0, Math.floor(Number(data.rowCount) || 0)),
      note: String(data.note || '').trim(),
      reviewed_at: new Date().toISOString(),
    }
    if (!(await isCloudReachable())) {
      await queueOperation('markAuditReviewed', newId('audit_review'), payload)
      await recordActivity('Audit', `Reviewed ${payload.row_count} audit row(s) offline.`)
      return { ...payload, pendingSync: true }
    }
    return pb.collection('audit_reviews').create(payload, { requestKey: `audit-review:${reviewedBy}:${data.fromDate || 'all'}:${data.toDate || 'all'}:${Date.now()}` }).catch(() => null)
  },
  gcashPayments: fetchGcashPayments,
  async settingsAdmins() {
    await startAdminRuntime()
    if (await isCloudReachable()) {
      const cloudRecords = await pb.collection('users').getFullList({
        filter: 'role = "admin"',
        sort: 'name,email',
        requestKey: null,
      })
      const records = await ensureQuickLoginEmailVisibility(cloudRecords)
      await cacheUsers(records)
      return records.map(toSettingsUser)
    }

    return (await adminDb.users.where('role').equals('admin').toArray()).map(toSettingsUser)
  },
  async updateAdminQuickLogin(id, enabled) {
    await startAdminRuntime()
    if (await isCloudReachable()) {
      const updated = await pb.collection('users').update(id, {
        quick_login_enabled: Boolean(enabled),
        ...(enabled ? { emailVisibility: true } : {}),
      }, { requestKey: null })
      await cacheUsers([updated])
      await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} admin quick login for "${updated.name || updated.email}".`)
      return toSettingsUser(updated)
    }

    await adminDb.users.update(id, { quick_login_enabled: Boolean(enabled) })
    await queueOperation('updateUserSettings', id, { quick_login_enabled: Boolean(enabled), ...(enabled ? { emailVisibility: true } : {}) })
    const updated = await adminDb.users.get(id)
    await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} admin quick login for "${updated.name || updated.email}".`)
    return toSettingsUser(updated)
  },
  updateAdminAuthorizationBarcode: async () => null,
  async generateAuthorizationBarcode(email, password) {
    await startAdminRuntime()
    const managerEmail = String(email || '').trim()
    const managerPassword = String(password || '')
    if (!managerEmail || !managerPassword) {
      throw new Error('Admin password is required.')
    }

    if (!(await isCloudReachable())) {
      const auth = await offlineLogin(managerEmail, managerPassword)
      const admin = auth.user
      const barcode = `90${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
      const local = {
        id: newId('auth'),
        barcode,
        label: 'Void and Discount Approval',
        status: 'active',
        generatedBy: admin.name || admin.email || 'Admin',
        generatedById: admin.id,
        generatedByEmail: admin.email || '',
        createdAt: new Date().toISOString(),
        pendingSync: true,
      }
      await adminDb.transaction('rw', adminDb.authorizationBarcodes, adminDb.pendingOps, async () => {
        await adminDb.authorizationBarcodes.put(local)
        await queueOperation('createAuthorizationBarcode', local.id, local)
      })
      return local
    }

    const authClient = new PocketBase(baseUrl)
    authClient.autoCancellation(false)
    const auth = await authClient.collection('users').authWithPassword(managerEmail, managerPassword).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to verify admin credentials.'))
    })

    const admin = auth.record
    if (admin?.role !== 'admin') throw new Error('Only admin accounts can generate authorization barcodes.')
    if (admin?.status === 'inactive') throw new Error('This admin account is inactive.')

    const barcode = `90${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
    const created = await pb.collection('authorization_barcodes').create({
      code: barcode,
      label: 'Void and Discount Approval',
      purpose: 'void_discount',
      status: 'active',
      generated_by: admin.id,
    }, {
      expand: 'generated_by',
      requestKey: null,
    }).catch((error) => {
      const message = pocketBaseErrorMessage(error, 'Unable to generate authorization barcode.')
      if (/superusers?/i.test(message)) {
        throw new Error('PocketHost rules still require a superuser for authorization barcodes. Run npm run pb:rules, then try again.')
      }
      throw new Error(message)
    })

    await recordActivity('Settings', 'Generated authorization barcode for void and discount approvals.')
    const normalized = {
      ...toAuthorizationBarcode(created),
      generatedById: admin.id,
      generatedByEmail: admin.email || '',
      pendingSync: false,
    }
    await adminDb.authorizationBarcodes.put(normalized)
    return normalized
  },
  async settingsCashiers() {
    return listDesktopCashiers()
  },
  async updateCashierQuickLogin(id, enabled) {
    await startAdminRuntime()
    if (await isCloudReachable()) {
      const updated = await pb.collection('users').update(id, {
        quick_login_enabled: Boolean(enabled),
        ...(enabled ? { emailVisibility: true } : {}),
      }, { requestKey: null })
      await cacheUsers([updated])
      await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} cashier quick login for "${updated.name || updated.email}".`)
      return toSettingsUser(updated)
    }

    await adminDb.users.update(id, { quick_login_enabled: Boolean(enabled) })
    await queueOperation('updateUserSettings', id, { quick_login_enabled: Boolean(enabled), ...(enabled ? { emailVisibility: true } : {}) })
    const updated = await adminDb.users.get(id)
    await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} cashier quick login for "${updated.name || updated.email}".`)
    return toSettingsUser(updated)
  },
}
