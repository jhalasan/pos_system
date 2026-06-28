import PocketBase from 'pocketbase'
import { initializeAdminDb, adminDb } from '../offline/db'
import { cashierDb, initializeCashierDb } from '../../cashier-pos/offline/db'
import { refreshAdminLocalCache } from '../offline/cloudBootstrap'
import { AdminSyncEngine } from '../offline/syncEngine'
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

const baseUrl = import.meta.env.VITE_POCKETBASE_URL

function requireBaseUrl() {
  if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for desktop admin access.')
}

export const pb = new PocketBase(baseUrl || 'http://127.0.0.1:8090')
pb.autoCancellation(false)

let adminSession = null
let runtimePromise = null
let syncEngine = null
let lastProductRefreshAt = 0
let inventoryScanQueue = Promise.resolve()

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

  try {
    await pb.health.check({ requestKey: null })
    return true
  } catch (error) {
    rememberPocketBaseRateLimit(error)
    return false
  }
}

function refreshProductsInBackground() {
  if (globalThis.navigator && !globalThis.navigator.onLine) return
  if (isPocketBaseRateLimited()) return
  if (Date.now() - lastProductRefreshAt < 30_000) return

  lastProductRefreshAt = Date.now()
  refreshAdminLocalCache({ pb }).catch((error) => {
    rememberPocketBaseRateLimit(error)
    lastProductRefreshAt = 0
  })
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
    lowStock: Number(record.min_stock) || 0,
    price: Number(record.price) || 0,
    image: image || '',
    imageUrl: fileUrl(record, image),
    tiers: [{ label: 'Retail', price: Number(record.price) || 0 }],
    status: deriveStatus(record),
  }
}

function isCriticalStock(product) {
  const status = deriveStatus(product)
  return status === 'critical' || status === 'out-of-stock'
}

function toSettingsUser(record) {
  const email = record.email || ''
  const name = record.name || email.split('@')[0] || 'User'

  return {
    id: record.id,
    name,
    email,
    role: record.role || '',
    shift: record.shift || '',
    status: record.status || 'active',
    cashierId: record.id,
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
    image: image || '',
    imageUrl: image ? pb.files.getURL(record, image, { thumb: '100x100' }) : '',
    sales: Number(sales) || 0,
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
    totalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    subtotalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod,
    refNumber,
    splitPayments,
    cashAmount: paymentMethod === 'cash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : 0,
    gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : 0,
    status: status === 'voided' ? 'Voided' : 'Completed',
    rawStatus: status,
    actionStatus: status === 'voided' ? 'Voided' : 'Reprint available',
    itemCount: items.length ? items.reduce((sum, item) => sum + saleItemQuantity(item), 0) : null,
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
  if (!(await isCloudReachable())) return filterReceiptRecords(localRecords, filters)

  const sales = await pb.collection('sales').getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    requestKey: null,
  }).catch(() => [])
  const cloudRecords = await Promise.all(sales.map(receiptRecordFromCloudSale))
  const merged = new Map()

  for (const record of cloudRecords) {
    merged.set(record.transactionNo || record.id, record)
  }
  for (const record of localRecords) {
    const key = record.transactionNo || record.id
    const existing = merged.get(key)
    if (!existing || ['adjusted', 'voided'].includes(record.rawStatus)) {
      merged.set(key, { ...existing, ...record })
    }
  }

  return filterReceiptRecords([...merged.values()], filters)
}

async function fetchGcashPayments() {
  await startAdminRuntime()
  if (!(await isCloudReachable())) return []

  const records = await pb.collection('sales').getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    requestKey: null,
  }).catch(() => [])

  return records.map(gcashPaymentFromSale).filter(Boolean)
}

function cashierPayload(data) {
  const payload = {
    name: String(data.name || '').trim(),
    email: String(data.email || '').trim(),
    shift: data.shift || 'Morning',
    status: data.status || 'active',
    role: 'cashier',
    emailVisibility: true,
  }

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
    formData.append(key, value ?? '')
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
  await adminDb.users.bulkPut(records.map((record) => ({
    id: record.id,
    email: record.email,
    name: record.name || record.email,
    role: record.role,
    shift: record.shift || '',
    status: record.status || 'active',
    quick_login_enabled: Boolean(record.quick_login_enabled),
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

function buildDashboardFromRecords(products, sales = [], saleItems = [], now = new Date()) {
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
  const monthlySaleIds = new Set(completedSales.filter((sale) => saleDate(sale) >= monthStart).map((sale) => sale.id))
  const productSales = new Map()
  let monthlyStockOut = 0

  for (const item of saleItems) {
    const saleId = firstRelation(item.sale_id ?? item.saleId)
    if (!completedSaleIds.has(saleId)) continue

    const quantity = Number(item.quantity_sold ?? item.quantity) || 0
    if (monthlySaleIds.has(saleId)) monthlyStockOut += quantity
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

  return {
    stats: {
      dailySales,
      dailySalesTrend: trend(dailySales, yesterdaySales),
      monthlySales,
      monthlySalesTrend: trend(monthlySales, lastMonthSales),
      totalRevenue,
      totalRevenueTrend: 0,
      criticalStock: criticalStockProducts.length,
    },
    criticalAlerts,
    productInOut: [
      { label: 'Stock In', value: currentStockUnits, color: '#16a34a' },
      { label: 'Stock Out', value: monthlyStockOut, color: '#ef4444' },
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
  const cached = {
    id: record.id,
    email: record.email,
    name: record.name || record.email,
    role: record.role,
    status: record.status || 'active',
    passwordHash: await sha256(`${record.email}:${password}`),
    updated: new Date().toISOString(),
  }
  await adminDb.users.put(cached)
  adminSession = cached
}

async function offlineLogin(email, password) {
  const cached = await adminDb.users.get({ email })
  if (!cached || cached.role !== 'admin' || cached.status === 'inactive') {
    throw new Error('Admin login requires internet the first time on this device.')
  }

  const passwordHash = await sha256(`${email}:${password}`)
  if (passwordHash !== cached.passwordHash) {
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
  const price = Number(data.price)
  return {
    id,
    sku: id,
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: String(data.category || '').trim(),
    categoryId: data.categoryId || '',
    qty: Number.isFinite(qty) ? Math.max(0, qty) : 0,
    unit: data.unit || 'Piece',
    lowStock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
    image: '',
    tiers: data.tiers || [{ label: 'Retail', price: Number(data.price) || 0 }],
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
    refreshProductsInBackground()
    return localProducts
  }

  if (await isCloudReachable()) {
    return fetchCloudProducts()
  }

  return getAllProducts()
}

async function listDesktopCashiers() {
  await startAdminRuntime()
  if (await isCloudReachable()) {
    const [cloudRecords, salesTotals] = await Promise.all([
      pb.collection('users').getFullList({
        filter: 'role = "cashier"',
        sort: 'name,email',
        requestKey: null,
      }),
      salesByCashier(),
    ])
    const records = await ensureQuickLoginEmailVisibility(cloudRecords)
    await cacheUsers(records)
    return records.map((record) => toCashierUser(record, salesTotals.get(record.id)))
  }

  return (await adminDb.users.where('role').equals('cashier').toArray()).map(toCashierUser)
}

export const desktopAdminApi = {
  async login(email, password) {
    requireBaseUrl()
    await startAdminRuntime()
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
      return { user: auth.record }
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

    return (await getLocalCategories()).map((name) => ({ id: name, name }))
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
    await adminDb.categories.put(local)
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
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      await adminDb.products.put(product)
      await queueOperation('updateProduct', id, product)
    })
    await recordActivity('Product', `Updated product "${product.name}".`)
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
    return null
  },

  async scanInventory({ barcode, qty = 1 }) {
    return enqueueInventoryScan(async () => {
      assertAdmin()
      await startAdminRuntime()
      const stockInQty = Math.max(1, Number(qty) || 1)
      let product = await getProductByBarcode(barcode)
      if (!product && (await isCloudReachable())) {
        await refreshAdminLocalCache({ pb })
        product = await getProductByBarcode(barcode)
      }
      if (!product) throw new Error(`No product found for barcode "${barcode}".`)

      let updated
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        const currentProduct = await adminDb.products.get(product.id)
        if (!currentProduct || currentProduct.deleted) {
          throw new Error(`No product found for barcode "${barcode}".`)
        }

        updated = {
          ...currentProduct,
          qty: Number(currentProduct.qty) + stockInQty,
          pendingSync: true,
          updated: new Date().toISOString(),
        }
        updated.status = deriveStatus(updated)
        await adminDb.products.put(updated)
        await queueOperation('scanInventory', updated.id, {
          id: updated.id,
          barcode: updated.barcode,
          qty: stockInQty,
        })
      })
      await recordActivity('Stock Update', `Added ${stockInQty} ${updated.unit || 'unit(s)'} to "${updated.name}".`)
      return updated
    })
  },

  async stockOutInventory({ barcode, qty = 1, reason = 'other', note = '' }) {
    return enqueueInventoryScan(async () => {
      assertAdmin()
      await startAdminRuntime()
      const stockOutQty = Math.max(1, Number(qty) || 1)
      let product = await getProductByBarcode(barcode)
      if (!product && (await isCloudReachable())) {
        await refreshAdminLocalCache({ pb })
        product = await getProductByBarcode(barcode)
      }
      if (!product) throw new Error(`No product found for barcode "${barcode}".`)

      let updated
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        const currentProduct = await adminDb.products.get(product.id)
        if (!currentProduct || currentProduct.deleted) {
          throw new Error(`No product found for barcode "${barcode}".`)
        }
        if ((Number(currentProduct.qty) || 0) < stockOutQty) {
          throw new Error(`"${currentProduct.name}" has only ${currentProduct.qty || 0} item(s) in stock.`)
        }

        updated = {
          ...currentProduct,
          qty: Math.max(0, Number(currentProduct.qty) - stockOutQty),
          pendingSync: true,
          updated: new Date().toISOString(),
        }
        updated.status = deriveStatus(updated)
        await adminDb.products.put(updated)
        await queueOperation('stockOutInventory', updated.id, {
          id: updated.id,
          barcode: updated.barcode,
          qty: stockOutQty,
          reason,
          note,
        })
      })
      await recordActivity('Stock Out', `Removed ${stockOutQty} ${updated.unit || 'unit(s)'} from "${updated.name}" - ${reason}${note ? ` (${note})` : ''}.`)
      return updated
    })
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

  async dashboard() {
    await startAdminRuntime()
    const localCompletedSales = await localCashierCompletedSales()
    if (!(await isCloudReachable())) {
      const products = await listDesktopProducts()
      const localSales = localCompletedSales.map(localSaleAsCloudLike)
      const localItems = localCompletedSales.flatMap(localSaleItems)
      return buildDashboardFromRecords(products, localSales, localItems, new Date())
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

    return buildDashboardFromRecords(products, sales, saleItems, new Date())
  },
  async syncNow() {
    await startAdminRuntime()
    await adminDb.pendingOps.where('status').equals('failed').modify({
      status: 'pending',
      nextAttemptAt: 0,
    })
    await adminDb.pendingOps.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    return syncEngine?.syncNow() || { uploaded: 0, failed: 0 }
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
    if (!(await isCloudReachable())) return []

    const records = await pb.collection('authorization_barcodes').getFullList({
      sort: '-created',
      expand: 'generated_by',
      requestKey: null,
    }).catch(() => [])

    return records.map(toAuthorizationBarcode)
  },
  async updateAuthorizationBarcodeStatus(id, status) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to update authorization barcodes.')
    }

    const nextStatus = status === 'revoked' ? 'revoked' : 'active'
    const updated = await pb.collection('authorization_barcodes').update(id, {
      status: nextStatus,
    }, {
      expand: 'generated_by',
      requestKey: null,
    }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to update authorization barcode.'))
    })

    await recordActivity('Settings', `${nextStatus === 'active' ? 'Enabled' : 'Disabled'} authorization barcode ${updated.code}.`)
    return toAuthorizationBarcode(updated)
  },
  async deleteAuthorizationBarcode(id) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to delete authorization barcodes.')
    }

    await pb.collection('authorization_barcodes').delete(id, { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to delete authorization barcode.'))
    })
    await recordActivity('Settings', `Deleted authorization barcode ${id}.`)
    return null
  },
  async cashiers() {
    return listDesktopCashiers()
  },
  receipts: fetchReceiptRecords,
  async createCashier(data) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to create cashier accounts.')
    }
    const created = await pb.collection('users').create(cashierBody(data), { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to create cashier.'))
    })
    await cacheUsers([created])
    await recordActivity('Cashier', `Created cashier "${created.name || created.email}".`)
    return toCashierUser(created)
  },
  async updateCashier(id, data) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to update cashier accounts.')
    }
    const body = cashierUpdateBody(data)
    const updated = await pb.collection('users').update(id, body, { requestKey: null }).catch((error) => {
      throw new Error(pocketBaseErrorMessage(error, 'Unable to update cashier.'))
    })
    await cacheUsers([updated])
    await recordActivity('Cashier', `Updated cashier "${updated.name || updated.email}".`)
    return toCashierUser(updated)
  },
  async deleteCashier(id) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to delete cashier accounts.')
    }
    await pb.collection('users').delete(id, { requestKey: null })
    await adminDb.users.delete(id)
    await recordActivity('Cashier', 'Deleted cashier account.')
    return null
  },
  async activityLogs() {
    await startAdminRuntime()
    const localLogs = await adminDb.activityLogs.orderBy('time').reverse().toArray()
    if (await isCloudReachable()) {
      const records = await pb.collection('activity_logs').getFullList({
        sort: '-timestamp,-created',
        expand: 'user_id',
        requestKey: null,
      }).catch(() => [])
      const logs = records.map(toCloudActivityLog)
      if (logs.length) await adminDb.activityLogs.bulkPut(logs)

      const merged = new Map()
      for (const log of [...logs, ...localLogs]) {
        const key = log.cloudId || log.id
        if (!merged.has(key)) merged.set(key, log)
      }
      return [...merged.values()].sort((a, b) => new Date(b.time) - new Date(a.time))
    }

    return localLogs
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
    const updated = await adminDb.users.get(id)
    await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} admin quick login for "${updated.name || updated.email}".`)
    return toSettingsUser(updated)
  },
  updateAdminAuthorizationBarcode: async () => null,
  async generateAuthorizationBarcode(email, password) {
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      throw new Error('Internet is required to generate authorization barcodes.')
    }

    const managerEmail = String(email || '').trim()
    const managerPassword = String(password || '')
    if (!managerEmail || !managerPassword) {
      throw new Error('Admin password is required.')
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
    return toAuthorizationBarcode(created)
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
    const updated = await adminDb.users.get(id)
    await recordActivity('Settings', `${enabled ? 'Enabled' : 'Disabled'} cashier quick login for "${updated.name || updated.email}".`)
    return toSettingsUser(updated)
  },
}
