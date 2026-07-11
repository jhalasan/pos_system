import PocketBase from 'pocketbase'
import { adminDb, initializeAdminDb } from '../../admin-page/offline/db'
import { initializeCashierDb } from '../offline/db'
import { cashierDb } from '../offline/db'
import { refreshLocalProductCatalog } from '../offline/cloudBootstrap'
import { getAllProducts, getProductByBarcode, normalizeProduct } from '../offline/productRepository'
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

let runtimePromise

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, number) : 0)
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

  if (products.length === 0 && (!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
    const activeRuntime = await runtime()
    await refreshLocalProductCatalog({ pb: activeRuntime.pb }).catch((error) => {
      rememberPocketBaseRateLimit(error)
      throw error
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
  return `${day}${String(Date.now()).slice(-6)}`
}

async function createCloudActivityLog({ cashierId, action, detail }) {
  if (globalThis.navigator && !globalThis.navigator.onLine) return null

  const activeRuntime = await runtime()
  return activeRuntime.pb.collection('activity_logs').create({
    user_id: cashierId,
    action_type: action,
    description: detail,
    timestamp: new Date().toISOString(),
  }, { requestKey: `activity:${cashierId}:${action}:${Date.now()}` }).catch(() => null)
}

async function createCloudRecord(collection, payload, requestKey) {
  if (globalThis.navigator && !globalThis.navigator.onLine) return null

  const activeRuntime = await runtime()
  return activeRuntime.pb.collection(collection).create(payload, { requestKey }).catch(() => null)
}

async function updateCloudRecord(collection, id, payload, requestKey) {
  const recordId = String(id || '').trim()
  if (!recordId || recordId.startsWith('shift_')) return null
  if (globalThis.navigator && !globalThis.navigator.onLine) return null

  const activeRuntime = await runtime()
  return activeRuntime.pb.collection(collection).update(recordId, payload, { requestKey }).catch(() => null)
}

function optionalRelation(value) {
  const normalized = String(value || '').trim()
  return normalized && !normalized.startsWith('shift_') ? normalized : undefined
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
  const activeRuntime = await runtime()

  if ((method === 'barcode' || (!method && code)) && code) {
    const authorizationRecord = await activeRuntime.pb.collection('authorization_barcodes').getFirstListItem(
      activeRuntime.pb.filter('code = {:code} && status = "active"', { code }),
      { expand: 'generated_by', requestKey: null },
    ).catch(() => null)

    if (authorizationRecord) {
      const generatedBy = Array.isArray(authorizationRecord.expand?.generated_by)
        ? authorizationRecord.expand.generated_by[0]
        : authorizationRecord.expand?.generated_by

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
    const adminClient = new PocketBase(import.meta.env.VITE_POCKETBASE_URL)
    adminClient.autoCancellation(false)
    const auth = await adminClient.collection('users').authWithPassword(email, password)
    const manager = auth.record

    if (!['manager', 'admin'].includes(manager?.role) && !(manager?.role === 'cashier' && String(manager?.void_barcode || '').startsWith('92'))) {
      throw new Error('Only manager accounts can approve cashier overrides.')
    }
    if (manager?.status === 'inactive') throw new Error('This manager account is inactive.')

    return {
      id: manager.id,
      name: manager.name || manager.email || 'Manager',
      email: manager.email || '',
      method: 'password',
    }
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
          String(candidate.barcode || '').trim() === normalizedBarcode
          || (Array.isArray(candidate.sellingUnits) && candidate.sellingUnits.some((unit) => (
            String(unit?.barcode || '').trim() === normalizedBarcode
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
    const auth = await activeRuntime.login(email, password).catch((error) => {
      rememberPocketBaseRateLimit(error)
      throw new Error(loginErrorMessage(error))
    })
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
    if (!isPocketBaseRateLimited()) {
      activeRuntime.refreshProducts().catch((error) => {
        rememberPocketBaseRateLimit(error)
        console.warn('Product catalog refresh failed after cashier login:', error)
      })
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

    if (!account && (!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      const record = await activeRuntime.pb.collection('users').getFirstListItem(
        activeRuntime.pb.filter('(void_barcode = {:code} || cashierBarcode = {:code}) && role = "cashier" && status != "inactive"', { code }),
        { requestKey: null },
      ).catch((error) => {
        rememberPocketBaseRateLimit(error)
        return null
      })
      if (record) {
        account = toCachedQuickLoginAccount(record)
        await cacheQuickLoginAccounts([record]).catch(() => {})
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
    return (await ensureProducts()).map(toCashierProduct)
  },

  async productByBarcode(barcode) {
    await initializeCashierDb()
    let product = await getProductByBarcode(barcode)

    const fallbackProduct = product
      ? await adminCachedProductByBarcode(barcode)
      : null
    if (fallbackProduct) {
      product = fallbackProduct
      await cashierDb.products.put(product)
    }

    if ((!globalThis.navigator || globalThis.navigator.onLine) && !isPocketBaseRateLimited()) {
      const activeRuntime = await runtime()
      await refreshLocalProductCatalog({ pb: activeRuntime.pb }).catch((error) => {
        rememberPocketBaseRateLimit(error)
        throw error
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
          String(record.barcode || '').trim() === normalizedBarcode
          || (Array.isArray(record.selling_units) && record.selling_units.some((unit) => (
            String(unit?.barcode || '').trim() === normalizedBarcode
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
      ? product.sellingUnits.find((unit) => String(unit.barcode || '').trim() === String(barcode || '').trim())
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
    const cloudSales = await cloudSalesHistory({ cashierId })
    const merged = new Map()

    for (const sale of [...cloudSales, ...localSales]) {
      merged.set(sale.transactionNo || sale.id, sale)
    }

    return [...merged.values()]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  },

  async saleLookup({ transactionNo }) {
    const sale = await findLocalSaleByTransactionNo(transactionNo)
    if (!sale) {
      const cloudSale = await cloudSaleLookup(transactionNo)
      if (cloudSale) return cloudSale
      throw new Error(`No completed transaction found for "${transactionNo}".`)
    }
    const pendingSales = await getPendingSales()
    return toCashierSale(sale, new Set(pendingSales.map((entry) => entry.clientSaleId)))
  },

  async completeSale(sale) {
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
    return activeRuntime.syncEngine.syncNow({ forceProductRefresh: true })
  },

  async authorizeVoid(code) {
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      throw new Error('Manager approval requires a network connection.')
    }
    return authorizeManagerApproval(code)
  },

  async logActivity({ cashierId, action, detail }) {
    return createCloudActivityLog({ cashierId, action, detail })
  },

  async openCashRegisterSession(session = {}) {
    const cashierId = String(session.cashierId || '').trim()
    if (!cashierId) return null

    return createCloudRecord('cash_register_sessions', {
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
    }, `cash-session:${session.id || cashierId}:${session.openedAt || Date.now()}`)
  },

  async closeCashRegisterSession(session = {}) {
    return updateCloudRecord('cash_register_sessions', session.id, {
      closing_amount: numberPayload(session.closingAmount),
      expected_closing_amount: numberPayload(session.expectedClosingAmount),
      actual_closing_amount: numberPayload(session.closingAmount),
      variance: Number(session.variance) || 0,
      cash_in_total: numberPayload(session.cashIn),
      cash_out_total: numberPayload(session.cashOut),
      status: 'closed',
      closed_at: session.closedAt || new Date().toISOString(),
      notes: String(session.closeNote || session.note || '').trim(),
      device_id: String(session.deviceId || '').trim(),
    }, `cash-session-close:${session.id}:${session.closedAt || Date.now()}`)
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
    }
    const sessionId = optionalRelation(movement.sessionId)
    const approvedBy = optionalRelation(movement.approvedBy)
    if (sessionId) payload.session_id = sessionId
    if (approvedBy) payload.approved_by = approvedBy

    return createCloudRecord('cash_movements', payload, `cash-movement:${movement.id || cashierId}:${payload.created_at}`)
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
    }
    const sessionId = optionalRelation(audit.sessionId)
    if (sessionId) payload.session_id = sessionId

    return createCloudRecord('cash_audits', payload, `cash-audit:${audit.id || cashierId}:${payload.created_at}`)
  },

  async voidCompletedSale({ saleId, cashierId, authorization, reason }) {
    const localSale = await findLocalSale(saleId)
    if (!localSale) throw new Error('Completed sale not found on this device.')
    if (localSale.status === 'voided') throw new Error('This transaction has already been voided.')

    const approver = await authorizeManagerApproval(authorization)

    if (localSale.syncStatus === 'synced' && (!globalThis.navigator || globalThis.navigator.onLine)) {
      try {
        const activeRuntime = await runtime()
        const cloudSale = await activeRuntime.pb.collection('sales').getFirstListItem(
          activeRuntime.pb.filter('transaction_no = {:transactionNo} && cashier_id = {:cashierId}', {
            transactionNo: localSale.transactionNo,
            cashierId: localSale.cashierId,
          }),
          { requestKey: null },
        ).catch(() => null)

        if (cloudSale && (cloudSale.status || 'completed') !== 'voided') {
          const saleItems = await activeRuntime.pb.collection('sale_items').getFullList({
            filter: activeRuntime.pb.filter('sale_id = {:saleId}', { saleId: cloudSale.id }),
            requestKey: null,
          })

          for (const item of saleItems) {
            const productId = Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
            if (!productId) continue
            const product = await activeRuntime.pb.collection('products').getOne(productId, { requestKey: null })
            const previousQuantity = Number(product.quantity) || 0
            const returnedQuantity = Number(item.quantity_sold) || 0
            const nextQuantity = previousQuantity + returnedQuantity
            await activeRuntime.pb.collection('products').update(product.id, {
              quantity: numberFieldValue(nextQuantity),
            }, { requestKey: null })
            await activeRuntime.pb.collection('stock_movements').create({
              product_id: product.id,
              movement_type: 'void_return',
              quantity: returnedQuantity,
              previous_quantity: previousQuantity,
              new_quantity: nextQuantity,
              reference_type: 'void',
              reference_id: cloudSale.id,
              notes: `Voided sale ${localSale.transactionNo}`,
              user_id: cashierId || localSale.cashierId,
              created_at: new Date().toISOString(),
            }, { requestKey: `stock-movement:void:${cloudSale.id}:${product.id}` }).catch(() => null)
          }

          await activeRuntime.pb.collection('sales').update(cloudSale.id, {
            status: 'voided',
            voided_by: approver.id || '',
          }, { requestKey: null })
        }
      } catch (error) {
        if (/superusers?/i.test(error?.message || '')) {
          throw new Error('PocketHost rules still require a superuser to void completed sales. Run npm run pb:rules, then try again.', { cause: error })
        }
        throw error
      }
    } else if (localSale.syncStatus === 'synced' && globalThis.navigator && !globalThis.navigator.onLine) {
      throw new Error('Internet is required to void a synced transaction.')
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

  async adjustCompletedSale({ saleId, cashierId, authorization, type, items, reason, note }) {
    const localSale = await findLocalSale(saleId)
    if (!localSale) throw new Error('Completed sale not found on this device.')
    if (localSale.status === 'voided') throw new Error('This transaction has already been voided.')

    const approver = await authorizeManagerApproval(authorization)

    if (localSale.syncStatus === 'synced' && (!globalThis.navigator || globalThis.navigator.onLine)) {
      const activeRuntime = await runtime()
      const cloudSale = await activeRuntime.pb.collection('sales').getFirstListItem(
        activeRuntime.pb.filter('transaction_no = {:transactionNo} && cashier_id = {:cashierId}', {
          transactionNo: localSale.transactionNo,
          cashierId: localSale.cashierId,
        }),
        { requestKey: null },
      ).catch(() => null)

      if (cloudSale && (cloudSale.status || 'completed') !== 'voided') {
        for (const item of items || []) {
          const productId = String(item.productId || item.id || '')
          const quantity = Math.max(0, Number(item.quantity) || 0)
          if (!productId || quantity <= 0) continue
          const product = await activeRuntime.pb.collection('products').getOne(productId, { requestKey: null })
          const previousQuantity = Number(product.quantity) || 0
          const nextQuantity = previousQuantity + quantity
          await activeRuntime.pb.collection('products').update(product.id, {
            quantity: numberFieldValue(nextQuantity),
          }, { requestKey: null })
          await activeRuntime.pb.collection('stock_movements').create({
            product_id: product.id,
            movement_type: type === 'exchange' ? 'exchange_return' : 'refund_return',
            quantity,
            previous_quantity: previousQuantity,
            new_quantity: nextQuantity,
            reference_type: type === 'exchange' ? 'exchange' : 'refund',
            reference_id: cloudSale.id,
            notes: `${type === 'exchange' ? 'Exchange' : 'Refund'} ${localSale.transactionNo}${reason ? `: ${reason}` : ''}`,
            user_id: cashierId || localSale.cashierId,
            created_at: new Date().toISOString(),
          }, { requestKey: `stock-movement:${type}:${cloudSale.id}:${product.id}:${quantity}` }).catch(() => null)
        }

        await activeRuntime.pb.collection('sales').update(cloudSale.id, {
          status: 'adjusted',
        }, { requestKey: null }).catch(() => null)
      }
    } else if (localSale.syncStatus === 'synced' && globalThis.navigator && !globalThis.navigator.onLine) {
      throw new Error('Internet is required to refund or exchange a synced transaction.')
    }

    const adjustedSale = await adjustLocalSale(saleId, {
      type,
      items,
      reason,
      note,
      approvedBy: approver.name,
      cashierId,
      createdAt: new Date().toISOString(),
    })

    const latestAdjustment = adjustedSale.adjustments?.at(-1)
    await createCloudActivityLog({
      cashierId: cashierId || localSale.cashierId,
      action: type === 'exchange' ? 'Transaction Exchange' : 'Transaction Refund',
      detail: `${type === 'exchange' ? 'Recorded exchange' : 'Refunded'} transaction ${localSale.transactionNo} for PHP ${Number(latestAdjustment?.amount || 0).toFixed(2)} approved by ${approver.name}${reason ? ` (${reason})` : ''}`,
    })

    return toCashierSale(adjustedSale)
  },
}
