import { desktopAdminApi } from './desktopApi'

const API_URL = import.meta.env.VITE_API_URL || '/api'
const isDesktopApp = import.meta.env.VITE_APP_TARGET === 'cashier-desktop'

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function request(path, options = {}) {
  let res
  try {
    const isFormData = options.body instanceof FormData
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: isFormData
        ? { ...(options.headers || {}) }
        : {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
          },
    })
  } catch {
    throw new Error(`Cannot reach API at ${API_URL}. Make sure npm run api is running.`)
  }

  if (res.status === 204) return null

  const text = await res.text().catch(() => '')
  const parsed = parseJson(text)

  if (!res.ok) {
    throw new Error(parsed?.error || text || `Request failed with HTTP ${res.status}.`)
  }

  if (parsed === null && text.trim()) {
    throw new Error(`Expected JSON from API at ${API_URL}${path}, but received a non-JSON response.`)
  }

  return parsed
}

function productBody(data) {
  const body = { ...data }
  if (body.hasMultipleUnits !== undefined && body.has_multiple_units === undefined) {
    body.has_multiple_units = body.hasMultipleUnits
  }

  if (!body.imageFile) return JSON.stringify(body)

  const formData = new FormData()
  for (const [key, value] of Object.entries(body)) {
    if (['imageFile', 'imageUrl', 'image', 'status', 'categoryId'].includes(key)) continue
    if (key === 'tiers' || key === 'sellingUnits') {
      formData.append(key, JSON.stringify(value || []))
      continue
    }
    formData.append(key, value ?? '')
  }
  formData.append('product_img', body.imageFile)
  return formData
}

function cashierBody(data) {
  if (!data.imageFile) return JSON.stringify(data)

  const formData = new FormData()
  for (const [key, value] of Object.entries(data)) {
    if (['imageFile', 'imageUrl', 'image'].includes(key)) continue
    formData.append(key, key === 'permissions' ? JSON.stringify(value || []) : (value ?? ''))
  }
  formData.append('profile_img', data.imageFile)
  return formData
}

export const peso = (n) => 'PHP ' + Number(n || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const statusLabel = {
  'in-stock': { text: 'In Stock', badge: 'badge-success' },
  low: { text: 'Low Stock', badge: 'badge-warning' },
  critical: { text: 'Critical', badge: 'badge-danger' },
  'out-of-stock': { text: 'Out of Stock', badge: 'badge-danger' },
}

export const defaultCategories = [
  'Beverages',
  'Grocery',
  'Bakery',
  'Tobacco',
  'Snacks',
  'Household',
  'Personal Care',
]

const webApi = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  adminQuickLoginAccounts: () => request('/auth/quick-login-accounts'),
  dashboard: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value))
    return request(`/dashboard${params.toString() ? `?${params}` : ''}`)
  },
  categories: () => request('/categories'),
  createCategory: (name) => request('/categories', { method: 'POST', body: JSON.stringify({ name }) }),
  products: () => request('/products'),
  nextProductBarcode: () => request('/barcodes/product/next'),
  latestAuthorizationBarcode: () => request('/barcodes/authorization/latest'),
  authorizationBarcodes: () => request('/barcodes/authorization'),
  updateAuthorizationBarcodeStatus: (id, status) => request(`/barcodes/authorization/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  }),
  deleteAuthorizationBarcode: (id) => request(`/barcodes/authorization/${id}`, { method: 'DELETE' }),
  createProduct: (data) => request('/products', { method: 'POST', body: productBody(data) }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PATCH', body: productBody(data) }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  scanInventory: (data) => request('/inventory/scan', { method: 'POST', body: JSON.stringify(data) }),
  stockOutInventory: (data) => request('/inventory/stock-out', { method: 'POST', body: JSON.stringify(data) }),
  adjustInventoryCount: (data) => request('/inventory/adjust-count', { method: 'POST', body: JSON.stringify(data) }),
  fsnInventory: () => request('/inventory/fsn'),
  cashiers: () => request('/cashiers'),
  staff: (role = 'cashier') => request(`/cashiers?role=${encodeURIComponent(role)}`),
  receipts: (filters = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters || {})) {
      if (value !== undefined && value !== null && String(value).trim()) {
        params.set(key, value)
      }
    }
    return request(`/receipts${params.toString() ? `?${params}` : ''}`)
  },
  gcashPayments: () => request('/gcash-payments'),
  createCashier: (data) => request('/cashiers', { method: 'POST', body: cashierBody(data) }),
  updateCashier: (id, data) => request(`/cashiers/${id}`, { method: 'PATCH', body: cashierBody(data) }),
  deleteCashier: (id) => request(`/cashiers/${id}`, { method: 'DELETE' }),
  createStaff: (data) => request('/cashiers', { method: 'POST', body: cashierBody(data) }),
  updateStaff: (id, data) => request(`/cashiers/${id}`, { method: 'PATCH', body: cashierBody(data) }),
  deleteStaff: (id) => request(`/cashiers/${id}`, { method: 'DELETE' }),
  activityLogs: () => request('/activity-logs'),
  markAuditReviewed: (data) => request('/audit-reviews', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  settingsAdmins: () => request('/settings/admins'),
  updateAdminQuickLogin: (id, enabled) => request(`/settings/admins/${id}/quick-login`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  }),
  updateAdminAuthorizationBarcode: (id, barcode) => request(`/settings/admins/${id}/authorization-barcode`, {
    method: 'PATCH',
    body: JSON.stringify({ barcode }),
  }),
  generateAuthorizationBarcode: (email, password) => request('/barcodes/authorization', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }),
  settingsCashiers: () => request('/settings/cashiers'),
  updateCashierQuickLogin: (id, enabled) => request(`/settings/cashiers/${id}/quick-login`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  }),
  syncNow: async () => ({ uploaded: 0, failed: 0 }),
  syncQueueDetails: async () => [],
  resolveSyncConflict: async () => ({ resolved: false }),
  discardFailedProductSync: async () => ({ discarded: false }),
  discardAllFailedProductSync: async () => ({ discarded: 0, productsRemoved: 0 }),
  offlineReadiness: async () => ({ ready: false, products: 0, cashierProducts: 0, categories: 0, users: 0, authorizationBarcodes: 0, managerApprovals: 0, offlineCashierLogins: 0, receipts: 0, pending: 0, failed: 0 }),
  downloadOfflineData: async () => ({ ready: false }),
  importStatus: () => request('/system/import-status'),
  backups: () => request('/system/backups'),
  backupPolicy: () => request('/system/backup-policy'),
  runAutomaticBackup: () => request('/system/backups/automatic', { method: 'POST', body: '{}' }),
  maintenanceReport: () => request('/system/maintenance-report'),
  createBackup: () => request('/system/backups', { method: 'POST', body: '{}' }),
  restoreBackup: (name, confirmation) => request(`/system/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: JSON.stringify({ confirmation }) }),
}

export const api = isDesktopApp
  ? { ...desktopAdminApi, importStatus: webApi.importStatus, backups: webApi.backups, backupPolicy: webApi.backupPolicy, runAutomaticBackup: webApi.runAutomaticBackup, maintenanceReport: webApi.maintenanceReport, createBackup: webApi.createBackup, restoreBackup: webApi.restoreBackup }
  : webApi
