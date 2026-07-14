import PocketBase from 'pocketbase'
import { adminDb, initializeAdminDb } from '../../admin-page/offline/db'
import { initializeCashierDb } from '../offline/db'
import { cashierDb } from '../offline/db'
import { refreshLocalProductCatalog } from '../offline/cloudBootstrap'
import { copyAdminProductCatalogToCashier } from '../offline/catalogCache'
import { getAllProducts, getProductByBarcode, normalizeProduct } from '../offline/productRepository'
import { barcodesMatch } from '../utils/barcodeUtils'
import {
  adjustLocalSale,
  finalizeSaleLocally,
  findLocalSale,
  findLocalSaleByTransactionNo,
  getCompletedSales,
  getPendingSales,
  voidLocalSale,
} from '../offline/saleRepository'
import { startCashierRuntime } from '../offline/runtime'
import {
  isPocketBaseRateLimit,
  isPocketBaseRateLimited,
  pocketBaseRateLimitMessage,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { getTerminalId } from '../../utils/terminalIdentity'
import { isDeveloperApprovalBarcode } from '../../utils/developerMode'

let runtimePromise

function pocketBaseErrorMessage(error, fallback = 'Unable to login right now.') {
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

function toQuickLoginAccount(record) {
  const email = String(record?.email || '').trim()
  const name = String(record?.name || '').trim()
  return {
    id: record.id,
    email,
    name: name || email.split('@')[0] || 'Cashier',
    role: record.role || 'cashier',
    status: record.status || 'active',
    shift: record.shift || '',
    cashierBarcode: String(record.cashierBarcode || record.void_barcode || '').trim(),
    permissions: Array.isArray(record.permissions) ? record.permissions : [],
  }
}

function toCachedQuickLoginAccount(record) {
  return {
    id: record.id,
    email: String(record.email || '').trim(),
    name: String(record.name || '').trim() || String(record.email || '').trim().split('@')[0] || 'Cashier',
    role: record.role || 'cashier',
    status: record.status || 'active',
    shift: record.shift || '',
    quickLoginEnabled: Boolean(record.quickLoginEnabled ?? record.quick_login_enabled),
    cashierBarcode: String(record.cashierBarcode || record.void_barcode || '').trim(),
    permissions: Array.isArray(record.permissions) ? record.permissions : [],
  }
}

function mergeAccountsById(...groups) {
  const accounts = new Map()
  for (const group of groups) {
    for (const account of group || []) {
      const id = account.id || account.email
      if (!id) continue
      accounts.set(id, { ...accounts.get(id), ...account })
    }
  }
  return [...accounts.values()]
}

async function cacheQuickLoginAccounts(records = []) {
  await initializeCashierDb()
  const normalized = records
    .map((record) => toCachedQuickLoginAccount(record))
    .filter((record) => record.email)

  await cashierDb.transaction('rw', cashierDb.quickLoginAccounts, async () => {
    await cashierDb.quickLoginAccounts.clear()
    if (normalized.length) await cashierDb.quickLoginAccounts.bulkPut(normalized)
  })
}

async function cachedQuickLoginAccounts() {
  await initializeCashierDb()
  return cashierDb.quickLoginAccounts
    .filter((account) => account.role === 'cashier' && !String(account.cashierBarcode || '').startsWith('92') && account.status === 'active' && account.quickLoginEnabled)
    .toArray()
    .then((records) => records.map(toQuickLoginAccount))
}

async function adminCachedCashierQuickLoginAccounts() {
  try {
    await initializeAdminDb()
    return adminDb.users
      .where('role')
      .equals('cashier')
      .filter((account) => !String(account.cashierBarcode || account.void_barcode || '').startsWith('92') && account.status === 'active' && Boolean(account.quick_login_enabled ?? account.quickLoginEnabled))
      .toArray()
      .then((records) => records.map(toQuickLoginAccount).filter((account) => account.email))
  } catch {
    return []
  }
}

function cachedApprover(record, code) {
  const barcode = String(record?.cashierBarcode || record?.void_barcode || '').trim()
  if (!barcode || barcode !== code) return null
  const role = String(record?.role || '').trim()
  const status = String(record?.status || 'active').trim()
  const isManagerBarcode = barcode.startsWith('92')
  const canApprove = role === 'manager' || role === 'admin' || (role === 'cashier' && isManagerBarcode)
  if (!canApprove || status === 'inactive') return null

  return {
    id: record.id || '',
    name: record.name || record.email || 'Manager',
    email: record.email || '',
    method: 'barcode',
  }
}

async function cachedManagerApprovalByBarcode(code) {
  const barcode = String(code || '').trim()
  if (!barcode) return null

  try {
    await initializeCashierDb()
    const cashierRecord = await cashierDb.quickLoginAccounts
      .filter((record) => cachedApprover(record, barcode))
      .first()
    const approver = cachedApprover(cashierRecord, barcode)
    if (approver) return approver
  } catch {
    // Cache fallback is best-effort; cloud lookup remains the source of truth.
  }

  try {
    await initializeAdminDb()
    const authorizationRecord = await adminDb.authorizationBarcodes
      .filter((record) => record.barcode === barcode && record.status === 'active' && !record.deleted)
      .first()
    if (authorizationRecord) {
      return {
        id: authorizationRecord.generatedById || '',
        name: authorizationRecord.generatedBy || 'Manager',
        email: authorizationRecord.generatedByEmail || '',
        method: 'barcode',
      }
    }
    const adminRecord = await adminDb.users
      .filter((record) => cachedApprover(record, barcode))
      .first()
    return cachedApprover(adminRecord, barcode)
  } catch {
    return null
  }
}

function runtime() {
  runtimePromise ||= startCashierRuntime()
  return runtimePromise
}

function toCashierProduct(product) {
  return {
    ...product,
    qty: product.quantity,
    lowStock: product.minStock,
  }
}

async function adminCachedProducts() {
  try {
    await initializeAdminDb()
    const products = await adminDb.products
      .filter((product) => !product.deleted)
      .toArray()

    return products.map((product) => ({
      ...product,
      quantity: Number(product.quantity ?? product.qty) || 0,
      minStock: Number(product.minStock ?? product.lowStock) || 0,
    }))
  } catch {
    return []
  }
}

function saleItemCount(sale) {
  return (sale.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
}

function saleAdjustmentAmount(sale) {
  return (sale.adjustments || []).reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0)
}

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

function toCashierSale(sale, pendingIds = new Set()) {
  const adjusted = Array.isArray(sale.adjustments) && sale.adjustments.length > 0
  let paymentMethod = sale.paymentMethod
  let refNumber = sale.refNumber || ''
  let splitPayments = sale.splitPayments

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }

  return {
    id: sale.clientSaleId,
    saleId: sale.clientSaleId,
    transactionNo: sale.transactionNo,
    totalAmount: sale.totalAmount,
    subtotalAmount: sale.subtotalAmount,
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod,
    cashAmount: sale.cashAmount,
    gcashAmount: sale.gcashAmount,
    change: sale.change,
    splitPayments,
    refNumber,
    status: sale.status === 'voided'
      ? 'Voided'
      : (adjusted ? 'Adjusted' : (pendingIds.has(sale.clientSaleId) || sale.syncStatus === 'pending' ? 'Pending sync' : 'Completed')),
    rawStatus: sale.status || 'completed',
    syncStatus: sale.syncStatus || (pendingIds.has(sale.clientSaleId) ? 'pending' : ''),
    createdAt: sale.createdAt,
    itemCount: saleItemCount(sale),
    items: sale.items || [],
    cashierId: sale.cashierId || '',
    cashierName: sale.cashierName || '',
    approvedBy: sale.voidedBy || '',
    voidedAt: sale.voidedAt || '',
    voidReason: sale.voidReason || '',
    adjustments: sale.adjustments || [],
    adjustedAt: sale.adjustedAt || '',
    adjustedAmount: saleAdjustmentAmount(sale),
  }
}

function cloudCashierName(sale) {
  const cashier = Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id
  return cashier?.name || cashier?.email || firstRelation(sale.cashier_id) || ''
}

function cloudSaleItemToLocal(item) {
  const product = Array.isArray(item.expand?.product_id)
    ? item.expand.product_id[0]
    : item.expand?.product_id

  return {
    productId: firstRelation(item.product_id) || '',
    name: product?.name || item.name || firstRelation(item.product_id) || 'Item',
    barcode: product?.barcode || item.barcode || '',
    quantity: Number(item.quantity_sold ?? item.quantity) || 0,
    price: Number(item.price_at_sale ?? item.price) || 0,
  }
}

function toCashierCloudSale(sale, items = []) {
  let paymentMethod = sale.payment_method || sale.paymentMethod || 'cash'
  let refNumber = sale.ref_number || sale.refNumber || ''
  let splitPayments = { cash: '', gcash: '', gcashRef: '' }

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }

  return toCashierSale({
    clientSaleId: sale.id,
    transactionNo: sale.transaction_no || sale.transactionNo || sale.id,
    totalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    subtotalAmount: Number(sale.subtotal_amount ?? sale.subtotalAmount ?? sale.total_amount) || 0,
    discountPercent: Number(sale.discount_percent ?? sale.discountPercent) || 0,
    discountAmount: Number(sale.discount_amount ?? sale.discountAmount) || 0,
    paymentMethod,
    cashAmount: paymentMethod === 'cash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : '',
    gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : '',
    change: 0,
    refNumber,
    splitPayments,
    status: sale.status || 'completed',
    syncStatus: 'synced',
    createdAt: sale.created_at || sale.createdAt || sale.created,
    cashierId: firstRelation(sale.cashier_id) || '',
    cashierName: cloudCashierName(sale),
    items,
    adjustments: [],
  })
}

async function cloudSaleItems(pb, saleId) {
  return pb.collection('sale_items').getFullList({
    filter: pb.filter('sale_id = {:saleId}', { saleId }),
    expand: 'product_id',
    requestKey: null,
  }).then((items) => items.map(cloudSaleItemToLocal))
}

async function cloudSalesHistory({ cashierId } = {}) {
  if (globalThis.navigator && !globalThis.navigator.onLine) return []

  const activeRuntime = await runtime()
  const filter = cashierId
    ? activeRuntime.pb.filter('cashier_id = {:cashierId}', { cashierId })
    : ''
  const sales = await activeRuntime.pb.collection('sales').getFullList({
    filter,
    sort: '-created_at,-created',
    expand: 'cashier_id',
    requestKey: null,
  }).catch(() => [])

  const withItems = await Promise.all(sales.map(async (sale) => (
    toCashierCloudSale(sale, await cloudSaleItems(activeRuntime.pb, sale.id).catch(() => []))
  )))

  return withItems
}

async function cloudSaleLookup(transactionNo) {
  if (globalThis.navigator && !globalThis.navigator.onLine) return null

  const activeRuntime = await runtime()
  const sale = await activeRuntime.pb.collection('sales').getFirstListItem(
    activeRuntime.pb.filter('transaction_no = {:transactionNo}', { transactionNo }),
    { expand: 'cashier_id', requestKey: null },
  ).catch(() => null)

  if (!sale) return null
  return toCashierCloudSale(sale, await cloudSaleItems(activeRuntime.pb, sale.id).catch(() => []))
}

async function ensureProducts() {
  await initializeCashierDb()
  let products = await getAllProducts()

  if (products.length === 0) {
    products = await copyAdminProductCatalogToCashier().catch(() => [])
  }

  if (
    products.length === 0
    && (!globalThis.navigator || globalThis.navigator.onLine)
    && !isPocketBaseRateLimited()
  ) {
    const activeRuntime = await runtime()
    await refreshLocalProductCatalog({ pb: activeRuntime.pb }).catch((error) => {
      rememberPocketBaseRateLimit(error)
    })
    products = await getAllProducts()
  }

  return products
}

function localTransactionNumber() {
  const now = new Date()
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const terminalCode = [...getTerminalId()].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 100
  return `${day}${String(terminalCode).padStart(2, '0')}${String(Date.now()).slice(-4)}`
}

function canUseOfflineLoginFallback(error) {
  return error?.status === 0
    || isPocketBaseRateLimit(error)
    || error instanceof TypeError
    || /network|fetch|timeout|offline|connection/i.test(String(error?.message || ''))
}

async function refreshAuthorizationBarcodeCache(activeRuntime) {
  const records = await activeRuntime.pb.collection('authorization_barcodes').getFullList({
    expand: 'generated_by',
    requestKey: null,
  })
  await initializeAdminDb()
  const normalized = records.map((record) => {
    const generatedBy = Array.isArray(record.expand?.generated_by) ? record.expand.generated_by[0] : record.expand?.generated_by
    return {
      id: record.id,
      barcode: record.code || '',
      label: record.label || 'Void and Discount Approval',
      status: record.status || 'active',
      generatedBy: generatedBy?.name || generatedBy?.email || 'Admin',
      generatedById: generatedBy?.id || '',
      generatedByEmail: generatedBy?.email || '',
      createdAt: record.created || new Date().toISOString(),
      pendingSync: false,
    }
  })
  await adminDb.transaction('rw', adminDb.authorizationBarcodes, async () => {
    const pending = await adminDb.authorizationBarcodes.filter((record) => record.pendingSync).toArray()
    await adminDb.authorizationBarcodes.clear()
    await adminDb.authorizationBarcodes.bulkPut([...normalized, ...pending])
  })
}

async function managerPasswordHash(email, password) {
  const bytes = new TextEncoder().encode(`manager-approval:${String(email).toLowerCase()}:${password}`)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function cachedManagerApprovalByPassword(email, password) {
  await initializeCashierDb()
  const credential = await cashierDb.settings.get(`managerApproval:${String(email).toLowerCase()}`)
  if (!credential?.value?.hash) return null
  const hash = await managerPasswordHash(email, password)
  return hash === credential.value.hash ? credential.value.manager : null
}

async function cashierPasswordHash(email, password) {
  const bytes = new TextEncoder().encode(`cashier-login:${String(email).toLowerCase()}:${password}`)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function cachedCashierLogin(email, password) {
  await initializeCashierDb()
  const credential = await cashierDb.settings.get(`cashierLogin:${String(email).toLowerCase()}`)
  if (!credential?.value?.hash) return null
  return await cashierPasswordHash(email, password) === credential.value.hash ? credential.value.user : null
}

async function cacheCashierSyncAuth(activeRuntime, user) {
  const token = activeRuntime.pb.authStore.token
  if (!token || !user?.id) return false
  await cashierDb.settings.put({
    key: `cashierSyncAuth:${user.id}`,
    value: { token, user, cachedAt: new Date().toISOString() },
  })
  return true
}

async function restoreCashierSyncAuth(activeRuntime, cashierId) {
  if (!cashierId) return false
  const credential = await cashierDb.settings.get(`cashierSyncAuth:${cashierId}`)
  const token = credential?.value?.token
  const user = credential?.value?.user
  if (!token || user?.id !== cashierId) return false
  activeRuntime.pb.authStore.save(token, user)
  if (activeRuntime.pb.authStore.isValid) return true
  activeRuntime.pb.authStore.clear()
  return false
}

async function retryPendingCashierSync(activeRuntime) {
  await cashierDb.pendingSales.where('status').equals('failed').modify({ status: 'pending', attempts: 0 })
  await cashierDb.pendingOps.where('status').equals('failed').modify({ status: 'pending', attempts: 0 })
  await cashierDb.pendingSales.where('status').equals('pending').modify({ nextAttemptAt: 0 })
  await cashierDb.pendingOps.where('status').equals('pending').modify({ nextAttemptAt: 0 })
  return activeRuntime.syncEngine.syncNow({ forceProductRefresh: true })
}

async function createCloudActivityLog({ cashierId, action, detail }) {
  const queued = await queueCashierOperation('activityLog', {
    user_id: cashierId,
    action_type: action,
    description: detail,
    timestamp: new Date().toISOString(),
  })
  if (globalThis.navigator && !globalThis.navigator.onLine) return queued
  const activeRuntime = await runtime()
  void activeRuntime.syncEngine.syncNow()
  return queued
}

async function queueCashierOperation(type, payload, entityId = '') {
  await initializeCashierDb()
  const id = globalThis.crypto?.randomUUID?.() || `${type}_${Date.now()}`
  await cashierDb.pendingOps.put({
    id,
    type,
    entityId: entityId || id,
    payload,
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
  })
  const activeRuntime = await runtime()
  activeRuntime.syncEngine.schedule(0)
  return { id: entityId || id, pendingSync: true }
}

function optionalRelation(value) {
  const normalized = String(value || '').trim()
  // PocketBase record relations only accept 15-character record IDs. Local
  // session IDs and synthetic approvers (for example Developer Mode) must not
  // be sent as relation values or the entire queued operation is rejected.
  return /^[a-z0-9]{15}$/.test(normalized) ? normalized : undefined
}

function numberPayload(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

async function authorizeManagerApproval(authorization = {}) {
  const payload = typeof authorization === 'string' ? { code: authorization } : authorization
  const method = String(payload?.method || '').trim().toLowerCase()
  const code = String(payload?.code || '').trim()
  const email = String(payload?.email || '').trim()
  const password = String(payload?.password || '')
  if (isDeveloperApprovalBarcode(code)) {
    return {
      id: 'developer-mode',
      name: 'Developer Mode',
      email: '',
      method: 'developer-barcode',
    }
  }
  const activeRuntime = await runtime()

  if (globalThis.navigator && !globalThis.navigator.onLine) {
    if ((method === 'barcode' || (!method && code)) && code) {
      const cachedManager = await cachedManagerApprovalByBarcode(code)
      if (cachedManager) return cachedManager
      throw new Error('Manager barcode is not cached on this terminal or is inactive.')
    }
    if ((method === 'password' || (!method && email && password)) && email && password) {
      const cachedManager = await cachedManagerApprovalByPassword(email, password)
      if (cachedManager) return { ...cachedManager, method: 'password' }
      throw new Error('These manager credentials have not been verified and cached on this terminal yet.')
    }
    throw new Error('Offline manager approval requires a cached barcode or previously verified manager credentials.')
  }

  if ((method === 'barcode' || (!method && code)) && code) {
    const authorizationRecord = await activeRuntime.pb.collection('authorization_barcodes').getFirstListItem(
      activeRuntime.pb.filter('code = {:code} && status = "active"', { code }),
      { expand: 'generated_by', requestKey: null },
    ).catch(() => null)

    if (authorizationRecord) {
      const generatedBy = Array.isArray(authorizationRecord.expand?.generated_by)
        ? authorizationRecord.expand.generated_by[0]
        : authorizationRecord.expand?.generated_by

      await initializeAdminDb().then(() => adminDb.authorizationBarcodes.put({
        id: authorizationRecord.id,
        barcode: authorizationRecord.code,
        label: authorizationRecord.label || 'Void and Discount Approval',
        status: authorizationRecord.status,
        generatedBy: generatedBy?.name || generatedBy?.email || 'Manager',
        generatedById: generatedBy?.id || '',
        generatedByEmail: generatedBy?.email || '',
        createdAt: authorizationRecord.created,
        pendingSync: false,
      })).catch(() => {})
      return {
        id: generatedBy?.id || '',
        name: generatedBy?.name || generatedBy?.email || 'Manager',
        email: generatedBy?.email || '',
        method: 'barcode',
      }
    }

    const legacyManager = await activeRuntime.pb.collection('users').getFirstListItem(
      activeRuntime.pb.filter('void_barcode = {:code} && (role = "manager" || role = "admin" || role = "cashier") && status != "inactive"', { code }),
      { requestKey: null },
    ).catch(() => null)

    if (legacyManager && (legacyManager.role !== 'cashier' || code.startsWith('92'))) {
      return {
        id: legacyManager.id,
        name: legacyManager.name || legacyManager.email || 'Manager',
        email: legacyManager.email || '',
        method: 'barcode',
      }
    }

    const cachedManager = await cachedManagerApprovalByBarcode(code)
    if (cachedManager) return cachedManager
  }

  if ((method === 'password' || (!method && email && password)) && email && password) {
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      throw new Error('Offline manager approval currently supports cached barcodes. Use a manager or authorization barcode.')
    }
    const adminClient = new PocketBase(import.meta.env.VITE_POCKETBASE_URL)
    adminClient.autoCancellation(false)
    const auth = await adminClient.collection('users').authWithPassword(email, password).catch(async (error) => {
      const cachedManager = await cachedManagerApprovalByPassword(email, password)
      if (cachedManager) return { record: { ...cachedManager, role: 'manager', status: 'active' } }
      throw error
    })
    const manager = auth.record

    if (!['manager', 'admin'].includes(manager?.role) && !(manager?.role === 'cashier' && String(manager?.void_barcode || '').startsWith('92'))) {
      throw new Error('Only manager accounts can approve cashier overrides.')
    }
    if (manager?.status === 'inactive') throw new Error('This manager account is inactive.')

    const approver = {
      id: manager.id,
      name: manager.name || manager.email || 'Manager',
      email: manager.email || '',
      method: 'password',
    }
    await initializeCashierDb()
    await cashierDb.settings.put({
      key: `managerApproval:${email.toLowerCase()}`,
      value: { hash: await managerPasswordHash(email, password), manager: approver },
    })
    return approver
  }

  throw new Error(code ? 'Manager barcode was not found or is inactive.' : 'Manager approval requires a barcode or manager email and password.')
}

async function adminCachedProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return null

  try {
    await initializeAdminDb()
    const record = await adminDb.products
      .filter((candidate) => (
        !candidate.deleted
        && (
          barcodesMatch(candidate.barcode, normalizedBarcode)
          || (Array.isArray(candidate.sellingUnits) && candidate.sellingUnits.some((unit) => (
            barcodesMatch(unit?.barcode, normalizedBarcode)
          )))
        )
      ))
      .first()
    return record ? normalizeProduct(record) : null
  } catch {
    return null
  }
}

export const desktopCashierApi = {
  async currentUser() {
    const activeRuntime = await runtime()
    return activeRuntime.pb.authStore.isValid ? activeRuntime.pb.authStore.record : null
  },

  async login(email, password) {
    const activeRuntime = await runtime()
    let auth
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      const cachedUser = await cachedCashierLogin(email, password)
      if (!cachedUser) throw new Error('Cashier login requires a previously verified account on this terminal.')
      auth = { record: cachedUser, offline: true }
    } else {
      auth = await activeRuntime.login(email, password).catch(async (error) => {
        if (canUseOfflineLoginFallback(error)) {
          const cachedUser = await cachedCashierLogin(email, password)
          if (cachedUser) return { record: cachedUser, offline: true }
        }
        rememberPocketBaseRateLimit(error)
        throw new Error(loginErrorMessage(error))
      })
    }
    if (auth.record?.role !== 'cashier') {
      activeRuntime.logout()
      throw new Error('Only cashier accounts can access this area.')
    }
    if (String(auth.record?.void_barcode || '').startsWith('92')) {
      activeRuntime.logout()
      throw new Error('Manager accounts are for approvals, not cashier POS login.')
    }
    if (auth.record?.status === 'inactive') {
      activeRuntime.logout()
      throw new Error('This account is inactive.')
    }
    if (!auth.offline) {
      await initializeCashierDb()
      await cashierDb.settings.put({
        key: `cashierLogin:${String(email).toLowerCase()}`,
        value: { hash: await cashierPasswordHash(email, password), user: auth.record },
      })
      await cacheCashierSyncAuth(activeRuntime, auth.record)
    } else {
      await restoreCashierSyncAuth(activeRuntime, auth.record.id)
    }
    if (activeRuntime.pb.authStore.isValid) void retryPendingCashierSync(activeRuntime)
    await createCloudActivityLog({
      cashierId: auth.record.id,
      action: 'Login',
      detail: 'Signed in to cashier POS',
    })
    void activeRuntime.pb.collection('users').getFullList({
      filter: 'role = "cashier" && quick_login_enabled = true && status != "inactive"',
      fields: 'id,name,email,role,shift,status,quick_login_enabled,void_barcode',
      sort: 'name',
      requestKey: null,
    }).then(cacheQuickLoginAccounts).catch(() => {})
    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      activeRuntime.refreshProducts().catch((error) => {
        rememberPocketBaseRateLimit(error)
        console.warn('Product catalog refresh failed after cashier login:', error)
      })
      refreshAuthorizationBarcodeCache(activeRuntime).catch(() => {})
    }
    return { user: auth.record }
  },

  async loginWithBarcode(barcode) {
    const code = String(barcode || '').trim()
    if (!code) throw new Error('Cashier barcode is required.')
    await initializeCashierDb()

    let account = await cashierDb.quickLoginAccounts
      .filter((record) => record.role === 'cashier' && record.status === 'active' && String(record.cashierBarcode || '').trim() === code)
      .first()

    if (!account) {
      try {
        await initializeAdminDb()
        account = await adminDb.users
          .where('role')
          .equals('cashier')
          .filter((record) => record.status === 'active' && String(record.cashierBarcode || record.void_barcode || '').trim() === code)
          .first()
      } catch {
        account = null
      }
    }

    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      let cloudChecked = false
      const record = await activeRuntime.pb.collection('users').getFirstListItem(
        activeRuntime.pb.filter('void_barcode = {:code} && role = "cashier" && status != "inactive"', { code }),
        { requestKey: null },
      ).then((result) => {
        cloudChecked = true
        return result
      }).catch((error) => {
        if (error?.status === 404) {
          cloudChecked = true
          return null
        }
        rememberPocketBaseRateLimit(error)
        if (!canUseOfflineLoginFallback(error)) {
          throw new Error(pocketBaseErrorMessage(error, 'Unable to verify this cashier barcode. Ask an administrator to refresh staff access.'))
        }
        return null
      })
      if (record) {
        account = toCachedQuickLoginAccount(record)
        await cacheQuickLoginAccounts([record]).catch(() => {})
      } else if (cloudChecked) {
        if (account?.id) await cashierDb.quickLoginAccounts.delete(account.id)
        throw new Error('This cashier barcode is no longer active. Download the latest staff access data or ask an administrator for a valid login.')
      }
    }

    if (!account) throw new Error('Invalid cashier barcode.')

    const user = {
      id: account.id,
      email: account.email,
      name: account.name || account.email || 'Cashier',
      role: 'cashier',
      status: 'active',
      cashierBarcode: account.cashierBarcode,
    }

    const activeRuntime = await runtime()
    await restoreCashierSyncAuth(activeRuntime, user.id)
    if (activeRuntime.pb.authStore.isValid) void retryPendingCashierSync(activeRuntime)

    await createCloudActivityLog({
      cashierId: user.id,
      action: 'Login',
      detail: 'Signed in to cashier POS using barcode',
    })
    return { user }
  },

  async logout() {
    const activeRuntime = await runtime()
    activeRuntime.logout()
  },

  async quickLoginAccounts() {
    await initializeCashierDb()
    const cachedAccounts = await cachedQuickLoginAccounts()
    const adminCachedAccounts = await adminCachedCashierQuickLoginAccounts()
    if ((globalThis.navigator && !globalThis.navigator.onLine) || isPocketBaseRateLimited()) {
      return mergeAccountsById(cachedAccounts, adminCachedAccounts)
    }
    const activeRuntime = await runtime()
    return activeRuntime.pb.collection('users').getFullList({
      filter: 'role = "cashier" && quick_login_enabled = true && status != "inactive"',
      fields: 'id,name,email,role,shift,status,quick_login_enabled,void_barcode',
      sort: 'name',
      requestKey: null,
    })
      .then(async (records) => {
        await cacheQuickLoginAccounts(records)
        return mergeAccountsById(records.map(toQuickLoginAccount), cachedAccounts, adminCachedAccounts)
          .filter((account) => !String(account.cashierBarcode || '').startsWith('92'))
          .filter((account) => account.email)
      })
      .catch((error) => {
        rememberPocketBaseRateLimit(error)
        return mergeAccountsById(cachedAccounts, adminCachedAccounts)
      })
  },

  async products() {
    const products = await ensureProducts()
    if (products.length > 0) {
      return products.map(toCashierProduct)
    }

    const adminProducts = await adminCachedProducts()
    if (adminProducts.length > 0) {
      const cached = adminProducts.map((product) => toCashierProduct(normalizeProduct(product)))
      await cashierDb.transaction('rw', cashierDb.products, async () => {
        await cashierDb.products.bulkPut(cached)
      })
      return cached
    }

    return []
  },

  async productByBarcode(barcode) {
    await initializeCashierDb()
    let product = await getProductByBarcode(barcode)

    let fallbackProduct = await adminCachedProductByBarcode(barcode)
    if (fallbackProduct) {
      product = fallbackProduct
      await cashierDb.products.put(product)
    }

    if (!product) {
      const adminProducts = await adminCachedProducts()
      if (adminProducts.length) {
        fallbackProduct = adminProducts.find((candidate) => (
          barcodesMatch(candidate.barcode, barcode)
          || (Array.isArray(candidate.sellingUnits) && candidate.sellingUnits.some((unit) => barcodesMatch(unit.barcode, barcode)))
        ))
        if (fallbackProduct) {
          product = normalizeProduct(fallbackProduct)
          await cashierDb.products.put(product)
        }
      }
    }

    if (!isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      await refreshLocalProductCatalog({ pb: activeRuntime.pb }).catch((error) => {
        rememberPocketBaseRateLimit(error)
      })
      const refreshedProduct = await getProductByBarcode(barcode)
      if (refreshedProduct) {
        product = refreshedProduct
      }

      // Resolve directly from the just-contacted cloud as a final safeguard.
      // This keeps a valid selling-unit barcode usable even if an older local
      // IndexedDB catalog did not persist the sellingUnits property correctly.
      if (!product) {
        const normalizedBarcode = String(barcode || '').trim()
        const cloudRecords = await activeRuntime.pb.collection('products').getFullList({
          expand: 'category',
          requestKey: null,
        })
        const cloudRecord = cloudRecords.find((record) => (
          barcodesMatch(record.barcode, normalizedBarcode)
          || (Array.isArray(record.selling_units) && record.selling_units.some((unit) => (
            barcodesMatch(unit?.barcode, normalizedBarcode)
          )))
        ))
        if (cloudRecord) {
          product = normalizeProduct(cloudRecord, activeRuntime.pb)
          await cashierDb.products.put(product)
        }
      }
    }
    if (!product && isPocketBaseRateLimited()) {
      throw new Error(`${pocketBaseRateLimitMessage()} Product barcode "${barcode}" is not cached on this cashier yet.`)
    }
    if (!product) throw new Error(`No local product found for barcode "${barcode}".`)
    if (Number(product.quantity ?? product.qty ?? 0) <= 0) throw new Error(`"${product.name}" is out of stock.`)

    const matchingUnit = Array.isArray(product.sellingUnits)
      ? product.sellingUnits.find((unit) => barcodesMatch(unit.barcode, barcode))
      : null
    const result = toCashierProduct(product)
    if (matchingUnit) {
      result.barcode = barcode
      result.unit = matchingUnit.unit || result.unit
      result.price = matchingUnit.price || result.price
      result.conversion = matchingUnit.conversion || 1
    } else {
      result.conversion = 1
    }
    return result
  },

  async nextTransactionNumber() {
    return { transactionNo: localTransactionNumber() }
  },

  async salesHistory({ cashierId }) {
    const [completedSales, pendingSales] = await Promise.all([getCompletedSales(), getPendingSales()])
    const pendingIds = new Set(pendingSales.map((sale) => sale.clientSaleId))
    const localSales = (completedSales.length ? completedSales : pendingSales)
      .filter((sale) => !cashierId || sale.cashierId === cashierId)
      .map((sale) => toCashierSale(sale, pendingIds))
    const cachedCloudSales = await cashierDb.receiptCache
      .filter((sale) => !cashierId || sale.cashierId === cashierId)
      .toArray()
    const cloudSales = await cloudSalesHistory({ cashierId })
    if (cloudSales.length) await cashierDb.receiptCache.bulkPut(cloudSales.map((sale) => ({ ...sale, id: sale.id || sale.saleId || sale.transactionNo })))
    const merged = new Map()

    for (const sale of [...cachedCloudSales, ...cloudSales, ...localSales]) {
      merged.set(sale.transactionNo || sale.id, sale)
    }

    return [...merged.values()]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  },

  async saleLookup({ transactionNo }) {
    const sale = await findLocalSaleByTransactionNo(transactionNo)
    if (!sale) {
      const cloudSale = await cloudSaleLookup(transactionNo)
      if (cloudSale) {
        await cashierDb.receiptCache.put({ ...cloudSale, id: cloudSale.id || cloudSale.saleId || cloudSale.transactionNo })
        return cloudSale
      }
      const cachedCloudSale = await cashierDb.receiptCache.filter((record) => record.transactionNo === transactionNo).first()
      if (cachedCloudSale) return cachedCloudSale
      throw new Error(`No completed transaction found for "${transactionNo}".`)
    }
    const pendingSales = await getPendingSales()
    return toCashierSale(sale, new Set(pendingSales.map((entry) => entry.clientSaleId)))
  },

  async completeSale(sale) {
    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      await activeRuntime.refreshProducts().catch((error) => {
        rememberPocketBaseRateLimit(error)
        if (!canUseOfflineLoginFallback(error)) throw error
      })
    }
    const queued = await finalizeSaleLocally({
      ...sale,
      transactionNo: sale.transactionNo || localTransactionNumber(),
    })
    const activeRuntime = await runtime()
    void activeRuntime.syncEngine.syncNow()
    return {
      id: queued.clientSaleId,
      transactionNo: queued.transactionNo,
      totalAmount: queued.totalAmount,
      pendingSync: true,
    }
  },

  async syncNow() {
    const activeRuntime = await runtime()
    await cashierDb.pendingSales.where('status').equals('failed').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 })
    await cashierDb.pendingOps.where('status').equals('failed').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 })
    await cashierDb.pendingSales.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    await cashierDb.pendingOps.where('status').equals('pending').modify({ nextAttemptAt: 0 })
    return activeRuntime.syncEngine.syncNow({ forceProductRefresh: true })
  },

  async syncQueueSummary() {
    await runtime()
    const [pendingSales, failedSales, pendingOps, failedOps] = await Promise.all([
      cashierDb.pendingSales.where('status').equals('pending').count(),
      cashierDb.pendingSales.where('status').equals('failed').count(),
      cashierDb.pendingOps.where('status').equals('pending').count(),
      cashierDb.pendingOps.where('status').equals('failed').count(),
    ])
    return { pending: pendingSales + pendingOps, failed: failedSales + failedOps, sales: pendingSales + failedSales }
  },

  async reauthenticate({ cashierId, email, password }) {
    const activeRuntime = await runtime()
    const normalizedEmail = String(email || '').trim().toLowerCase()
    if (!normalizedEmail || !password) throw new Error('Cashier email and password are required.')
    const auth = await activeRuntime.login(normalizedEmail, password).catch((error) => {
      throw new Error(loginErrorMessage(error))
    })
    if (auth.record?.role !== 'cashier' || (cashierId && auth.record.id !== cashierId)) {
      activeRuntime.logout()
      throw new Error('Sign in with the cashier account currently using this POS session.')
    }
    if (auth.record?.status === 'inactive') {
      activeRuntime.logout()
      throw new Error('This cashier account is inactive.')
    }
    await cashierDb.settings.put({
      key: `cashierLogin:${normalizedEmail}`,
      value: { hash: await cashierPasswordHash(normalizedEmail, password), user: auth.record },
    })
    await cacheCashierSyncAuth(activeRuntime, auth.record)
    return retryPendingCashierSync(activeRuntime)
  },

  async authorizeVoid(code) {
    return authorizeManagerApproval(code)
  },

  async logActivity({ cashierId, action, detail }) {
    return createCloudActivityLog({ cashierId, action, detail })
  },

  async openCashRegisterSession(session = {}) {
    const cashierId = String(session.cashierId || '').trim()
    if (!cashierId) return null

    const localId = session.id || `shift_${globalThis.crypto?.randomUUID?.() || Date.now()}`
    return queueCashierOperation('openCashRegisterSession', {
      cashier_id: cashierId,
      opening_amount: numberPayload(session.openingAmount),
      closing_amount: 0,
      expected_closing_amount: 0,
      actual_closing_amount: 0,
      variance: 0,
      cash_in_total: 0,
      cash_out_total: 0,
      status: 'open',
      opened_at: session.openedAt || new Date().toISOString(),
      notes: String(session.note || '').trim(),
      device_id: String(session.deviceId || '').trim(),
    }, localId)
  },

  async closeCashRegisterSession(session = {}) {
    return queueCashierOperation('closeCashRegisterSession', {
      sessionId: session.id,
      cashier_id: String(session.cashierId || '').trim(),
      opening_amount: numberPayload(session.openingAmount),
      closing_amount: numberPayload(session.closingAmount),
      expected_closing_amount: numberPayload(session.expectedClosingAmount),
      actual_closing_amount: numberPayload(session.closingAmount),
      variance: Number(session.variance) || 0,
      cash_in_total: numberPayload(session.cashIn),
      cash_out_total: numberPayload(session.cashOut),
      status: 'closed',
      opened_at: session.openedAt || '',
      closed_at: session.closedAt || new Date().toISOString(),
      notes: String(session.closeNote || session.note || '').trim(),
      device_id: String(session.deviceId || '').trim(),
    }, session.id)
  },

  async recordCashMovement(movement = {}) {
    const cashierId = String(movement.cashierId || '').trim()
    if (!cashierId) return null

    const payload = {
      cashier_id: cashierId,
      type: movement.type === 'in' ? 'in' : 'out',
      amount: numberPayload(movement.amount),
      category: String(movement.category || '').trim(),
      note: String(movement.note || '').trim(),
      approval_method: movement.approvalMethod === 'password' ? 'password' : movement.approvalMethod === 'barcode' ? 'barcode' : 'manual',
      device_id: String(movement.deviceId || '').trim(),
      created_at: movement.createdAt || new Date().toISOString(),
      localSessionId: String(movement.sessionId || '').trim(),
    }
    const sessionId = optionalRelation(movement.sessionId)
    const approvedBy = optionalRelation(movement.approvedBy)
    if (sessionId) payload.session_id = sessionId
    if (approvedBy) payload.approved_by = approvedBy

    return queueCashierOperation('recordCashMovement', payload, movement.id)
  },

  async recordCashAudit(audit = {}) {
    const cashierId = String(audit.cashierId || '').trim()
    if (!cashierId) return null

    const payload = {
      cashier_id: cashierId,
      cash_beginning: numberPayload(audit.cashBeginning),
      cash_sales: numberPayload(audit.cashSales),
      cash_in: numberPayload(audit.cashIn),
      cash_out: numberPayload(audit.cashOut),
      expected_cash: numberPayload(audit.expectedCash),
      cash_ending: numberPayload(audit.cashEnding),
      actual_cash: numberPayload(audit.actualCash),
      cash_on_hand: numberPayload(audit.cashOnHand),
      denomination_total: numberPayload(audit.denominationTotal),
      variance: Number(audit.variance) || 0,
      count_mode: audit.countMode === 'denomination' ? 'denomination' : 'manual',
      denominations: Array.isArray(audit.denominations) ? audit.denominations : [],
      note: String(audit.note || '').trim(),
      device_id: String(audit.deviceId || '').trim(),
      created_at: audit.createdAt || new Date().toISOString(),
      localSessionId: String(audit.sessionId || '').trim(),
    }
    const sessionId = optionalRelation(audit.sessionId)
    if (sessionId) payload.session_id = sessionId

    return queueCashierOperation('recordCashAudit', payload, audit.id)
  },

  async voidCompletedSale({ saleId, cashierId, authorization, reason }) {
    const localSale = await findLocalSale(saleId)
    if (!localSale) throw new Error('Completed sale not found on this device.')
    if (localSale.status === 'voided') throw new Error('This transaction has already been voided.')

    const approver = await authorizeManagerApproval(authorization)

    if (localSale.syncStatus === 'synced') {
      await queueCashierOperation('voidCompletedSale', {
        transactionNo: localSale.transactionNo,
        cashierId: cashierId || localSale.cashierId,
        approverId: approver.id || '',
        reason: String(reason || ''),
        items: localSale.items || [],
        createdAt: new Date().toISOString(),
      }, saleId)
    }

    const voidedSale = await voidLocalSale(saleId, {
      reason,
      voidedAt: new Date().toISOString(),
      voidedBy: approver.name,
    })

    await createCloudActivityLog({
      cashierId: cashierId || localSale.cashierId,
      action: 'Transaction Void',
      detail: `Voided completed transaction ${localSale.transactionNo} approved by ${approver.name}${reason ? ` (${reason})` : ''}`,
    })

    return {
      id: voidedSale.clientSaleId,
      transactionNo: voidedSale.transactionNo,
      status: 'Voided',
      approvedBy: approver.name,
      voidedAt: voidedSale.voidedAt,
    }
  },

  async adjustCompletedSale({ saleId, cashierId, authorization, type, items, reason, note, restock = true }) {
    const localSale = await findLocalSale(saleId)
    if (!localSale) throw new Error('Completed sale not found on this device.')
    if (localSale.status === 'voided') throw new Error('This transaction has already been voided.')

    const approver = await authorizeManagerApproval(authorization)

    await queueCashierOperation('adjustCompletedSale', {
        transactionNo: localSale.transactionNo,
        cashierId: cashierId || localSale.cashierId,
        approverId: approver.id || '',
        type: type === 'exchange' ? 'exchange' : 'refund',
        items: items || [],
        reason: String(reason || ''),
        note: String(note || ''),
        restock: restock !== false,
        createdAt: new Date().toISOString(),
    }, saleId)

    const adjustedSale = await adjustLocalSale(saleId, {
      type,
      items,
      reason,
      note,
      restock: restock !== false,
      approvedBy: approver.name,
      cashierId,
      createdAt: new Date().toISOString(),
    })

    const latestAdjustment = adjustedSale.adjustments?.at(-1)
    await createCloudActivityLog({
      cashierId: cashierId || localSale.cashierId,
      action: type === 'exchange' ? 'Transaction Exchange' : 'Transaction Refund',
      detail: `${type === 'exchange' ? 'Recorded exchange' : 'Refunded'} transaction ${localSale.transactionNo} for PHP ${Number(latestAdjustment?.amount || 0).toFixed(2)} approved by ${approver.name}${reason ? ` (${reason})` : ''}; ${restock !== false ? 'returned to stock' : 'not restocked'}`,
    })

    return toCashierSale(adjustedSale)
  },
}
