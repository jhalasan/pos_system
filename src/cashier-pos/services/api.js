import { desktopCashierApi } from './desktopApi'

const API_URL = import.meta.env.VITE_API_URL || '/api'
const isDesktopCashier = import.meta.env.VITE_APP_TARGET === 'cashier-desktop'

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const text = await res.text().catch(() => '')
  const payload = parseJson(text)

  if (!res.ok) {
    throw new Error(payload?.error || text || 'Request failed.')
  }

  if (payload === null && text.trim()) {
    throw new Error(`Expected JSON from API at ${API_URL}${path}, but received a non-JSON response.`)
  }

  return payload
}

export const money = (n) => 'PHP ' + Number(n || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const webCashierApi = {
  login: (email, password) => request('/cashier/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }),
  quickLoginAccounts: () => request('/cashier/quick-login-accounts'),
  products: () => request('/cashier/products'),
  productByBarcode: (barcode) => request(`/cashier/products/barcode/${encodeURIComponent(barcode)}`),
  nextTransactionNumber: () => request('/cashier/next-transaction-number'),
  salesHistory: ({ cashierId, q = '' }) => request(
    `/cashier/sales?cashierId=${encodeURIComponent(cashierId || '')}&q=${encodeURIComponent(q)}`
  ),
  authorizeVoid: (code) => request('/cashier/authorize-void', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }),
  logActivity: ({ cashierId, action, detail }) => request('/cashier/activity-log', {
    method: 'POST',
    body: JSON.stringify({ cashierId, action, detail }),
  }),
  completeSale: (sale) => request('/cashier/sales', {
    method: 'POST',
    body: JSON.stringify(sale),
  }),
}

export const cashierApi = isDesktopCashier ? desktopCashierApi : {
  ...webCashierApi,
  currentUser: async () => null,
  logout: async () => {},
}
