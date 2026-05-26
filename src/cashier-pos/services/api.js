const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const payload = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(payload?.error || 'Request failed.')
  }

  return payload
}

export const money = (n) => 'PHP ' + Number(n || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const cashierApi = {
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
  completeSale: (sale) => request('/cashier/sales', {
    method: 'POST',
    body: JSON.stringify(sale),
  }),
}
