import { initializeCashierDb } from '../offline/db'
import { refreshLocalProductCatalog } from '../offline/cloudBootstrap'
import { getAllProducts, getProductByBarcode } from '../offline/productRepository'
import {
  finalizeSaleLocally,
  getCompletedSales,
  getPendingSales,
} from '../offline/saleRepository'
import { startCashierRuntime } from '../offline/runtime'

let runtimePromise

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

async function ensureProducts() {
  await initializeCashierDb()
  let products = await getAllProducts()

  if (products.length === 0 && (!globalThis.navigator || globalThis.navigator.onLine)) {
    const activeRuntime = await runtime()
    await refreshLocalProductCatalog({ pb: activeRuntime.pb })
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

export const desktopCashierApi = {
  async currentUser() {
    const activeRuntime = await runtime()
    return activeRuntime.pb.authStore.isValid ? activeRuntime.pb.authStore.record : null
  },

  async login(email, password) {
    const activeRuntime = await runtime()
    const auth = await activeRuntime.login(email, password)
    activeRuntime.refreshProducts().catch((error) => {
      console.warn('Product catalog refresh failed after cashier login:', error)
    })
    return { user: auth.record }
  },

  async logout() {
    const activeRuntime = await runtime()
    activeRuntime.logout()
  },

  async quickLoginAccounts() {
    if (globalThis.navigator && !globalThis.navigator.onLine) return []
    const activeRuntime = await runtime()
    return activeRuntime.pb.collection('users').getFullList({
      filter: 'role = "cashier" && quick_login = true && status = "active"',
      fields: 'id,name,email',
      sort: 'name',
      requestKey: null,
    }).catch(() => [])
  },

  async products() {
    return (await ensureProducts()).map(toCashierProduct)
  },

  async productByBarcode(barcode) {
    await initializeCashierDb()
    const product = await getProductByBarcode(barcode)
    if (!product) throw new Error(`No local product found for barcode "${barcode}".`)
    if (product.quantity <= 0) throw new Error(`"${product.name}" is out of stock.`)
    return toCashierProduct(product)
  },

  async nextTransactionNumber() {
    return { transactionNo: localTransactionNumber() }
  },

  async salesHistory({ cashierId }) {
    const [completedSales, pendingSales] = await Promise.all([getCompletedSales(), getPendingSales()])
    const pendingIds = new Set(pendingSales.map((sale) => sale.clientSaleId))
    const sales = completedSales.length ? completedSales : pendingSales
    return sales
      .filter((sale) => !cashierId || sale.cashierId === cashierId)
      .map((sale) => ({
        id: sale.clientSaleId,
        transactionNo: sale.transactionNo,
        totalAmount: sale.totalAmount,
        paymentMethod: sale.paymentMethod,
        status: pendingIds.has(sale.clientSaleId) || sale.syncStatus === 'pending' ? 'Pending sync' : 'Completed',
        createdAt: sale.createdAt,
        itemCount: sale.items.reduce((sum, item) => sum + item.quantity, 0),
        items: sale.items,
      }))
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

  async authorizeVoid(code) {
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      throw new Error('Manager approval requires a network connection.')
    }
    const activeRuntime = await runtime()
    return activeRuntime.pb.collection('authorization_barcodes').getFirstListItem(
      activeRuntime.pb.filter('code = {:code} && status = "active"', { code }),
      { requestKey: null },
    )
  },

  async logActivity({ cashierId, action, detail }) {
    return createCloudActivityLog({ cashierId, action, detail })
  },
}
