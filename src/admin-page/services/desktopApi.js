import PocketBase from 'pocketbase'
import { initializeAdminDb, adminDb } from '../offline/db'
import { refreshAdminLocalCache } from '../offline/cloudBootstrap'
import { AdminSyncEngine } from '../offline/syncEngine'
import {
  deriveStatus,
  getAllProducts,
  getProductByBarcode,
  replaceProductsFromCloud,
} from '../offline/productRepository'

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

    if (!globalThis.navigator || globalThis.navigator.onLine) {
      refreshAdminLocalCache({ pb }).catch(() => {})
    }

    return { syncEngine }
  })()

  return runtimePromise
}

async function isCloudReachable() {
  await startAdminRuntime()
  if (globalThis.navigator && !globalThis.navigator.onLine) return false

  try {
    await pb.health.check({ requestKey: null })
    return true
  } catch {
    return false
  }
}

function refreshProductsInBackground() {
  if (globalThis.navigator && !globalThis.navigator.onLine) return
  if (Date.now() - lastProductRefreshAt < 30_000) return

  lastProductRefreshAt = Date.now()
  refreshAdminLocalCache({ pb }).catch(() => {
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

function cashierPayload(data) {
  const payload = {
    name: String(data.name || '').trim(),
    email: String(data.email || '').trim(),
    shift: data.shift || 'Morning',
    status: data.status || 'active',
    role: 'cashier',
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
    updated: record.updated || new Date().toISOString(),
  })))
}

const emptyDashboard = {
  stats: {
    dailySales: 0,
    dailySalesTrend: 0,
    monthlySales: 0,
    monthlySalesTrend: 0,
    totalRevenue: 0,
    totalRevenueTrend: 0,
    criticalStock: 0,
  },
  criticalAlerts: [],
  productInOut: [
    { label: 'Stock In', value: 0, color: '#16a34a' },
    { label: 'Stock Out', value: 0, color: '#ef4444' },
  ],
  topProducts: [],
  hourlySales: [],
  monthlySales: [],
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
  return {
    id,
    sku: id,
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: String(data.category || '').trim(),
    categoryId: data.categoryId || '',
    qty: Number(data.qty) || 0,
    unit: data.unit || 'Piece',
    lowStock: Number(data.lowStock) || 0,
    price: Number(data.price) || 0,
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

  const localProducts = await getAllProducts()
  if (localProducts.length > 0) {
    refreshProductsInBackground()
    return localProducts
  }

  if (await isCloudReachable()) {
    const records = await pb.collection('products').getFullList({
      sort: 'name',
      expand: 'category',
      requestKey: null,
    })
    await replaceProductsFromCloud(records, pb)
    return records.map(toProduct)
  }

  return getAllProducts()
}

async function listDesktopCashiers() {
  await startAdminRuntime()
  if (await isCloudReachable()) {
    const [records, salesTotals] = await Promise.all([
      pb.collection('users').getFullList({
        filter: 'role = "cashier"',
        sort: 'name,email',
        requestKey: null,
      }),
      salesByCashier(),
    ])
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
      await cacheAdminLogin(auth.record, password)
      await recordActivity('Login', 'Signed in to admin dashboard.')
      refreshAdminLocalCache({ pb }).catch(() => {})
      return { user: auth.record }
    } catch (error) {
      if (globalThis.navigator && !globalThis.navigator.onLine) {
        return offlineLogin(email, password)
      }
      if (error?.status === 0) return offlineLogin(email, password)
      throw error
    }
  },

  logout() {
    pb.authStore.clear()
    adminSession = null
  },

  async adminQuickLoginAccounts() {
    requireBaseUrl()
    await startAdminRuntime()
    if (!(await isCloudReachable())) {
      return adminDb.users
        .where('role')
        .equals('admin')
        .filter((user) => user.status === 'active' && Boolean(user.quick_login_enabled ?? user.quickLoginEnabled))
        .toArray()
        .then((records) => records.map(toSettingsUser).filter((user) => user.email))
    }
    return pb.collection('users').getFullList({
      filter: 'role = "admin" && quick_login_enabled = true && status = "active"',
      fields: 'id,name,email,role,status',
      sort: 'name',
      requestKey: null,
    })
      .then(async (records) => {
        await cacheUsers(records.map((record) => ({
          ...record,
          quick_login_enabled: true,
        })))
        return records.map(toSettingsUser).filter((user) => user.email)
      })
      .catch(() => [])
  },

  async products() {
    return listDesktopProducts()
  },

  async createProduct(data) {
    assertAdmin()
    await startAdminRuntime()
    const product = await localProductFromForm(data)
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
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
    assertAdmin()
    await startAdminRuntime()
    const stockInQty = Math.max(1, Number(qty) || 1)
    let product = await getProductByBarcode(barcode)
    if (!product && (await isCloudReachable())) {
      await refreshAdminLocalCache({ pb })
      product = await getProductByBarcode(barcode)
    }
    if (!product) throw new Error(`No product found for barcode "${barcode}".`)
    const updated = {
      ...product,
      qty: Number(product.qty) + stockInQty,
      pendingSync: true,
      updated: new Date().toISOString(),
    }
    updated.status = deriveStatus(updated)
    await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
      await adminDb.products.put(updated)
      await queueOperation('scanInventory', updated.id, { id: updated.id, qty: stockInQty })
    })
    await recordActivity('Stock Update', `Added ${stockInQty} ${updated.unit || 'unit(s)'} to "${updated.name}".`)
    return updated
  },

  async fsnInventory() {
    const products = await listDesktopProducts()
    return products.map((product) => ({
      ...product,
      fsn: 'Non-moving',
      fsnReason: 'Desktop local mode has no movement analysis yet',
      units90: 0,
      averageMonthlyUnits: 0,
    }))
  },

  async nextProductBarcode() {
    return { barcode: `29${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 10)}` }
  },

  async dashboard() {
    await startAdminRuntime()
    const products = await listDesktopProducts()
    const criticalAlerts = products
      .filter((product) => product.status === 'critical')
      .slice(0, 8)
      .map((product) => ({ name: product.name, left: product.qty }))

    return {
      ...emptyDashboard,
      stats: {
        ...emptyDashboard.stats,
        criticalStock: criticalAlerts.length,
      },
      criticalAlerts,
      productInOut: [
        {
          label: 'Stock In',
          value: products.reduce((sum, product) => sum + Number(product.qty || 0), 0),
          color: '#16a34a',
        },
        { label: 'Stock Out', value: 0, color: '#ef4444' },
      ],
    }
  },
  async syncNow() {
    await startAdminRuntime()
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
  async settingsAdmins() {
    await startAdminRuntime()
    if (await isCloudReachable()) {
      const records = await pb.collection('users').getFullList({
        filter: 'role = "admin"',
        sort: 'name,email',
        requestKey: null,
      })
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
      throw new Error(pocketBaseErrorMessage(error, 'Unable to generate authorization barcode.'))
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
