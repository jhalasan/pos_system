import { adminDb, initializeAdminDb } from '../../admin-page/offline/db'
import { initializeCashierDb } from '../offline/db'
import { cashierDb } from '../offline/db'
import { refreshLocalProductCatalog } from '../offline/cloudBootstrap'
import { copyAdminProductCatalogToCashier } from '../offline/catalogCache'
import { getAllProducts, getProductByBarcode, normalizeProduct, safeBulkPutProducts, isCatalogIncomplete } from '../offline/productRepository'
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
import { peekNextTransactionNumber } from '../offline/transactionNumber'
import { startCashierRuntime } from '../offline/runtime'
import {
  isPocketBaseRateLimit,
  isPocketBaseRateLimited,
  pocketBaseRateLimitMessage,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { isDeveloperApprovalBarcode } from '../../utils/developerMode'
import { forceRetryNow } from '../../utils/pendingQueueRetry'
import { groupSaleItemsBySaleId } from '../../utils/saleItemGrouping'
import { findApprovalHashMatch } from '../../utils/managerApprovalHash'

let runtimePromise

const API_URL = import.meta.env.VITE_API_URL || '/api'

// Manager approval, quick-login account listing, and barcode login all used
// to read the `authorization_barcodes`/`users` PocketBase collections
// directly with the cashier's own token, which meant any cashier could list
// every manager's approval code. Those collections are now admin-only (see
// scripts/configure-pocketbase-rules.mjs); this terminal instead calls the
// existing Express /api/cashier/* endpoints, which use the server's own
// PocketBase credentials and never hand back the underlying code list.
async function cashierApiRequest(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const text = await res.text().catch(() => '')
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!res.ok) {
    const error = new Error(payload?.error || text || 'Request failed.')
    error.status = res.status
    throw error
  }
  return payload
}

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
    profileImage: Array.isArray(record.profile_img) ? record.profile_img[0] : (record.profile_img || record.profileImage || ''),
    imageUrl: record.imageUrl || '',
  }
}

function cashierProfileImageUrl(record, pbClient) {
  if (record?.imageUrl) return record.imageUrl
  const image = Array.isArray(record?.profile_img) ? record.profile_img[0] : (record?.profile_img || record?.profileImage || '')
  if (!image || !record?.id || !pbClient?.files?.getURL) return ''
  return pbClient.files.getURL(record, image, { thumb: '100x100' })
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

  if (sales.length === 0) return []

  // One bulk fetch grouped in memory, instead of one request per sale (even
  // bounded-concurrency, that was still N requests for N sales — reliably
  // exceeding PocketHost's per-IP concurrent-request cap on a busy day and
  // silently dropping line items on the overflowed requests). Mirrors the
  // same fix already shipped on the admin side (see
  // admin-page/services/desktopApi.js's fetchReceiptRecords).
  const allItemsFetchFailed = { failed: false }
  const allSaleItems = await activeRuntime.pb.collection('sale_items').getFullList({
    sort: 'created',
    expand: 'product_id',
    requestKey: null,
  }).catch(() => {
    allItemsFetchFailed.failed = true
    return []
  })
  const itemsBySaleId = groupSaleItemsBySaleId(allSaleItems)

  return sales.map((sale) => {
    const items = itemsBySaleId.get(sale.id)
    // A sale that genuinely has zero items looks identical to "the bulk
    // fetch failed" unless the fetch's own outcome is tracked separately —
    // only treat this as a failure if the whole fetch errored, not just
    // because this particular sale had no matching group.
    const itemsFetchFailed = allItemsFetchFailed.failed
    return {
      sale: toCashierCloudSale(sale, (items || []).map(cloudSaleItemToLocal)),
      itemsFetchFailed,
    }
  })
}

async function cloudSaleLookup(transactionNo) {
  if (globalThis.navigator && !globalThis.navigator.onLine) return null

  const activeRuntime = await runtime()
  const sale = await activeRuntime.pb.collection('sales').getFirstListItem(
    activeRuntime.pb.filter('transaction_no = {:transactionNo}', { transactionNo }),
    { expand: 'cashier_id', requestKey: null },
  ).catch(() => null)

  if (!sale) return null
  const items = await cloudSaleItems(activeRuntime.pb, sale.id).catch(() => null)
  return { sale: toCashierCloudSale(sale, items || []), itemsFetchFailed: items === null }
}

async function ensureProducts() {
  await initializeCashierDb()
  let products = await getAllProducts()

  if (products.length === 0) {
    products = await copyAdminProductCatalogToCashier().catch(() => [])
  }

  // An incomplete catalog (short row count vs. the last successful refresh,
  // or a refresh that skipped rows) never repairs itself otherwise — a
  // non-empty cache previously short-circuited this whole block forever.
  const incomplete = products.length === 0 || await isCatalogIncomplete().catch(() => false)

  if (
    incomplete
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

function canUseOfflineLoginFallback(error) {
  return error?.status === 0
    || isPocketBaseRateLimit(error)
    || error instanceof TypeError
    || /network|fetch|timeout|offline|connection/i.test(String(error?.message || ''))
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
  // Never wipe attempts -- see forceRetryNow's own comment. This runs on
  // every login, not just an explicit user action, so resetting a
  // persistently-failing op's counter here was even worse than doing it on
  // a manual sync click: it happened silently, every single login.
  await forceRetryNow(cashierDb.pendingSales)
  await forceRetryNow(cashierDb.pendingOps)
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

const MANAGER_APPROVAL_HASHES_KEY = 'managerApprovalHashes'
const MANAGER_APPROVAL_HASHES_REFRESH_INTERVAL_MS = 15 * 60_000
let managerApprovalHashesRefreshLoopStarted = false

// Offline manager approval (reversing S1's original online-only decision,
// per client request -- relying on internet always being up isn't
// realistic for their store). The server hands out only a salted, one-way
// hash of each active manager credential (GET
// /api/cashier/manager-approval-hashes, see server/index.js and
// src/utils/managerApprovalHash.js) -- the real barcode is never cached
// here, so this does not reopen the leak S1 closed.
async function refreshManagerApprovalHashes() {
  if (globalThis.navigator && !globalThis.navigator.onLine) return false
  if (isPocketBaseRateLimited()) return false
  try {
    await initializeCashierDb()
    const activeRuntime = await runtime()
    const staffToken = activeRuntime.pb.authStore.token
    const result = await cashierApiRequest('/cashier/manager-approval-hashes', {
      headers: staffToken ? { Authorization: `Bearer ${staffToken}` } : {},
    })
    const entries = Array.isArray(result?.entries) ? result.entries : []
    await cashierDb.settings.put({
      key: MANAGER_APPROVAL_HASHES_KEY,
      value: { entries, fetchedAt: new Date().toISOString() },
    })
    return true
  } catch (error) {
    rememberPocketBaseRateLimit(error)
    return false
  }
}

async function cachedManagerApprovalHashes() {
  await initializeCashierDb()
  const cached = await cashierDb.settings.get(MANAGER_APPROVAL_HASHES_KEY)
  return Array.isArray(cached?.value?.entries) ? cached.value.entries : []
}

// Started once per app session (from a successful login), not tied to the
// sync engine's own tick loop -- this cache only matters for an action a
// cashier might take at any moment (a void/refund needing approval), not
// for anything queued, so it keeps its own simple, independent schedule.
function startManagerApprovalHashesRefreshLoop() {
  if (managerApprovalHashesRefreshLoopStarted) return
  managerApprovalHashesRefreshLoopStarted = true
  globalThis.setInterval?.(() => {
    void refreshManagerApprovalHashes()
  }, MANAGER_APPROVAL_HASHES_REFRESH_INTERVAL_MS)
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

  const usePassword = (method === 'password' || (!method && email && password)) && email && password
  const useBarcode = !usePassword && (method === 'barcode' || (!method && code)) && code
  if (!usePassword && !useBarcode) {
    throw new Error(code ? 'Manager barcode was not found or is inactive.' : 'Manager approval requires a barcode or manager email and password.')
  }

  const offline = Boolean(globalThis.navigator) && !globalThis.navigator.onLine
  const rateLimited = isPocketBaseRateLimited()

  if (!offline && !rateLimited) {
    const requestBody = usePassword ? { email, password } : { code }
    try {
      const activeRuntime = await runtime()
      const staffToken = activeRuntime.pb.authStore.token
      const result = await cashierApiRequest('/cashier/authorize-void', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: staffToken ? { Authorization: `Bearer ${staffToken}` } : {},
      })
      // A successful online approval is also a good moment to refresh the
      // offline cache -- best-effort, never blocks the approval that just
      // succeeded.
      void refreshManagerApprovalHashes()
      return result?.approver
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      if (!canUseOfflineLoginFallback(error)) {
        throw new Error(error?.message || 'Manager approval failed.', { cause: error })
      }
      // Network/rate-limit-shaped failure -- fall through to the offline
      // hash check below rather than failing outright.
    }
  }

  // Offline fallback: barcode only. Password-based approval still requires
  // connectivity -- caching a verifiable hash of a manager's actual login
  // password offline is a materially different risk than a low-entropy
  // barcode and was not part of what was asked for here.
  if (!useBarcode) {
    throw new Error('Manager approval by email and password requires an internet connection. Use a manager barcode instead, or reconnect.')
  }
  const cachedEntries = await cachedManagerApprovalHashes()
  const match = await findApprovalHashMatch(code, cachedEntries)
  if (!match) {
    throw new Error(cachedEntries.length
      ? 'Manager barcode was not found or is inactive.'
      : 'Manager approval is not available offline yet on this terminal -- connect to the internet at least once so approval data can be cached.')
  }
  return {
    id: match.approverId,
    name: match.approverName,
    email: '',
    method: 'barcode-offline',
  }
}

async function adminCachedProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return null

  try {
    await initializeAdminDb()
    const indexedMatch = await adminDb.products.where('barcode').equals(normalizedBarcode).first()
    if (indexedMatch && !indexedMatch.deleted) return normalizeProduct(indexedMatch)

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
    if (!activeRuntime.pb.authStore.isValid) return null
    let record = activeRuntime.pb.authStore.record
    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      record = await activeRuntime.pb.collection('users').authRefresh({ requestKey: null })
        .then((auth) => auth.record)
        .catch(() => record)
    }
    return record ? { ...record, imageUrl: cashierProfileImageUrl(record, activeRuntime.pb) } : null
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
    void cashierApiRequest('/cashier/quick-login-accounts').then(cacheQuickLoginAccounts).catch(() => {})
    void refreshManagerApprovalHashes()
    startManagerApprovalHashesRefreshLoop()
    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      activeRuntime.refreshProducts().catch((error) => {
        rememberPocketBaseRateLimit(error)
        console.warn('Product catalog refresh failed after cashier login:', error)
      })
    }
    return { user: { ...auth.record, imageUrl: cashierProfileImageUrl(auth.record, activeRuntime.pb) } }
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

    // Captures the server's verified record (including the impersonated
    // session token it mints, see server/index.js's /cashier/auth/barcode)
    // when the online path below runs, so it can be applied to this
    // terminal's own PocketBase session afterward -- see the comment further
    // down for why that matters.
    let onlineVerifiedRecord = null

    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      let cloudChecked = false
      // Verified server-side (POST /api/cashier/auth/barcode), not by
      // listing `users` with this terminal's own token — that collection is
      // admin-only now (see scripts/configure-pocketbase-rules.mjs).
      const record = await cashierApiRequest('/cashier/auth/barcode', {
        method: 'POST',
        body: JSON.stringify({ barcode: code }),
      }).then((result) => {
        cloudChecked = true
        return result?.user || null
      }).catch((error) => {
        if (error?.status === 401) {
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
        onlineVerifiedRecord = record
        if (record.status === 'inactive') {
          if (account?.id) await cashierDb.quickLoginAccounts.delete(account.id)
          throw new Error('This cashier account is inactive. Ask an administrator to reactivate it before logging in.')
        }
        account = {
          ...toCachedQuickLoginAccount(record),
          imageUrl: cashierProfileImageUrl(record, activeRuntime.pb),
        }
        // Refresh only this cashier. Clearing the full cache here would remove
        // every other cashier after one successful barcode login.
        await cashierDb.quickLoginAccounts.put(account).catch(() => {})
      } else if (cloudChecked && !account) {
        throw new Error('Cashier barcode was not found. Download the latest staff access data or ask an administrator to verify the barcode.')
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
      imageUrl: account.imageUrl || '',
      profileImage: account.profileImage || '',
    }

    const activeRuntime = await runtime()
    if (onlineVerifiedRecord?.token) {
      // The server mints a real PocketBase session (impersonation)
      // specifically so a barcode-logged-in terminal can authenticate its
      // own /api/cashier/* calls and background sync -- but this used to be
      // thrown away, falling through to restoreCashierSyncAuth below, which
      // only reuses whatever was cached from a *previous* login. For a
      // cashier who mostly logs in by barcode, that cached token can go
      // stale enough that PocketBase's own listRule silently filters every
      // row out of a background sync's product refresh (a 200 with zero
      // results, not an auth error, since a listRule acts as a per-record
      // filter) -- surfacing as "the cloud returned zero products" right
      // after an unrelated action like a void, which forces an immediate
      // catalog refresh. Apply and persist the fresh token now instead.
      activeRuntime.pb.authStore.save(onlineVerifiedRecord.token, onlineVerifiedRecord)
      if (activeRuntime.pb.authStore.isValid) {
        await cacheCashierSyncAuth(activeRuntime, onlineVerifiedRecord)
      } else {
        activeRuntime.pb.authStore.clear()
        await restoreCashierSyncAuth(activeRuntime, user.id)
      }
    } else {
      await restoreCashierSyncAuth(activeRuntime, user.id)
    }
    if (activeRuntime.pb.authStore.isValid) void retryPendingCashierSync(activeRuntime)

    await createCloudActivityLog({
      cashierId: user.id,
      action: 'Login',
      detail: 'Signed in to cashier POS using barcode',
    })
    void refreshManagerApprovalHashes()
    startManagerApprovalHashesRefreshLoop()
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
        // A successful cloud response is authoritative. Merging the pre-refresh
        // caches here resurrected deleted/disabled cashiers on the login screen.
        return records.map(toQuickLoginAccount)
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
        await safeBulkPutProducts(cashierDb.products, cached)
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
      if (!product) {
        // True cache miss: nothing to show yet, so it's worth the wait to
        // check the cloud before telling the cashier the barcode is unknown.
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
      } else {
        // Already have a product to show — don't make the cashier wait on a
        // full catalog re-sync just to open the confirm-quantity popup.
        // Refresh in the background so later scans stay fresh.
        runtime()
          .then((activeRuntime) => refreshLocalProductCatalog({ pb: activeRuntime.pb, background: true }))
          .catch((error) => rememberPocketBaseRateLimit(error))
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
    await initializeCashierDb()
    // A display estimate only -- the number actually recorded is minted
    // fresh, atomically, inside finalizeSaleLocally. See
    // offline/transactionNumber.js.
    return { transactionNo: await peekNextTransactionNumber() }
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
    const cloudResults = await cloudSalesHistory({ cashierId })
    const cloudSales = cloudResults.map((result) => result.sale)
    // Never persist a sale whose item fetch failed - caching a wrongly-empty
    // items list would make that failure permanent (see cloudSalesHistory).
    const fetchedCloudSales = cloudResults.filter((result) => !result.itemsFetchFailed).map((result) => result.sale)
    if (fetchedCloudSales.length) await cashierDb.receiptCache.bulkPut(fetchedCloudSales.map((sale) => ({ ...sale, id: sale.id || sale.saleId || sale.transactionNo })))
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
      const cloudResult = await cloudSaleLookup(transactionNo)
      if (cloudResult) {
        const { sale: cloudSale, itemsFetchFailed } = cloudResult
        // Same guard as salesHistory(): don't cache a lookup whose item
        // fetch failed, or a transient failure becomes a permanent
        // wrongly-empty receipt.
        if (!itemsFetchFailed) {
          await cashierDb.receiptCache.put({ ...cloudSale, id: cloudSale.id || cloudSale.saleId || cloudSale.transactionNo })
        }
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
    // finalizeSaleLocally always mints its own transactionNo atomically; any
    // value passed here is ignored (see transactionNumber.js).
    const queued = await finalizeSaleLocally(sale)
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
    if (isPocketBaseRateLimited()) {
      const message = pocketBaseRateLimitMessage()
      if (typeof globalThis.CustomEvent === 'function') {
        globalThis.dispatchEvent?.(new CustomEvent('nexa-sync-status', {
          detail: { scope: 'cashier', state: 'waiting', message },
        }))
      }
      return {
        uploaded: 0,
        failed: 0,
        products: 0,
        warnings: [message],
        pending: (await cashierDb.pendingSales.count()) + (await cashierDb.pendingOps.count()),
      }
    }
    await forceRetryNow(cashierDb.pendingSales)
    await forceRetryNow(cashierDb.pendingOps)
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

    // adjustLocalSale clamps the requested quantities against what's
    // actually left to refund and queues the cloud op itself, atomically, in
    // the same Dexie transaction as the local stock restore — using that
    // same clamped result, never these raw `items` from the caller. See
    // saleRepository.js for why: queuing raw UI input separately let a
    // refund of 99 units on a 2-unit line restock 2 locally but 99 in the
    // cloud.
    const adjustedSale = await adjustLocalSale(saleId, {
      type,
      items,
      reason,
      note,
      restock: restock !== false,
      approvedBy: approver.name,
      approverId: approver.id || '',
      cashierId,
      createdAt: new Date().toISOString(),
    })

    const activeRuntime = await runtime()
    activeRuntime.syncEngine.schedule(0)

    const latestAdjustment = adjustedSale.adjustments?.at(-1)
    await createCloudActivityLog({
      cashierId: cashierId || localSale.cashierId,
      action: type === 'exchange' ? 'Transaction Exchange' : 'Transaction Refund',
      detail: `${type === 'exchange' ? 'Recorded exchange' : 'Refunded'} transaction ${localSale.transactionNo} for PHP ${Number(latestAdjustment?.amount || 0).toFixed(2)} approved by ${approver.name}${reason ? ` (${reason})` : ''}; ${restock !== false ? 'returned to stock' : 'not restocked'}`,
    })

    return toCashierSale(adjustedSale)
  },
}
