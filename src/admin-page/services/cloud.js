import PocketBase from 'pocketbase'

const baseUrl = import.meta.env.VITE_POCKETBASE_URL
if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for the admin dashboard.')

export const pb = new PocketBase(baseUrl)
pb.autoCancellation(false)

export async function loginAdmin(email, password) {
  return pb.collection('users').authWithPassword(email, password)
}

export function logoutAdmin() {
  pb.authStore.clear()
}

export async function fetchSalesReport({ from, to, page = 1, perPage = 100 } = {}) {
  const filters = ['status != "voided"']
  const params = {}

  if (from) {
    filters.push('created_at >= {:from}')
    params.from = new Date(from).toISOString()
  }
  if (to) {
    filters.push('created_at <= {:to}')
    params.to = new Date(to).toISOString()
  }

  return pb.collection('sales').getList(page, perPage, {
    filter: pb.filter(filters.join(' && '), params),
    sort: '-created_at',
    expand: 'cashier_id',
    requestKey: null,
  })
}

export async function updateProductStock(productId, quantity) {
  const nextQuantity = Number(quantity)
  if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
    throw new Error('Stock quantity must be a non-negative integer.')
  }

  return pb.collection('products').update(productId, {
    quantity: nextQuantity,
  }, {
    requestKey: `product-stock:${productId}`,
  })
}

export async function subscribeToSales(onChange) {
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function.')

  await pb.collection('sales').subscribe('*', onChange, {
    expand: 'cashier_id',
  })

  return () => pb.collection('sales').unsubscribe('*')
}

export async function subscribeToProducts(onChange) {
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function.')

  await pb.collection('products').subscribe('*', onChange)
  return () => pb.collection('products').unsubscribe('*')
}
