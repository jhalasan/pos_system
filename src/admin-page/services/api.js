const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: isFormData
      ? { ...(options.headers || {}) }
      : {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
  })

  if (res.status === 204) return null

  const payload = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(payload?.error || 'Request failed.')
  }

  return payload
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
  createProduct: (data) => request('/products', { method: 'POST', body: productBody(data) }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PATCH', body: productBody(data) }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  scanInventory: (data) => request('/inventory/scan', { method: 'POST', body: JSON.stringify(data) }),
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
  settingsCashiers: () => request('/settings/cashiers'),
  updateCashierQuickLogin: (id, enabled) => request(`/settings/cashiers/${id}/quick-login`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  }),
}
