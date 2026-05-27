const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

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

  return parsed
}

function productBody(data) {
  if (!data.imageFile) return JSON.stringify(data)

  const formData = new FormData()
  for (const [key, value] of Object.entries(data)) {
    if (['imageFile', 'imageUrl', 'image', 'status', 'categoryId'].includes(key)) continue
    if (key === 'tiers') {
      formData.append(key, JSON.stringify(value || []))
      continue
    }
    formData.append(key, value ?? '')
  }
  formData.append('product_img', data.imageFile)
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

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  adminQuickLoginAccounts: () => request('/auth/quick-login-accounts'),
  dashboard: () => request('/dashboard'),
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
  fsnInventory: () => request('/inventory/fsn'),
  cashiers: () => request('/cashiers'),
  createCashier: (data) => request('/cashiers', { method: 'POST', body: JSON.stringify(data) }),
  updateCashier: (id, data) => request(`/cashiers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCashier: (id) => request(`/cashiers/${id}`, { method: 'DELETE' }),
  activityLogs: () => request('/activity-logs'),
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
}
