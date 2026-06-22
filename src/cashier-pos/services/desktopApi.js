import PocketBase from 'pocketbase'
import { initializeCashierDb } from '../offline/db'
import { cashierDb } from '../offline/db'
import { refreshLocalProductCatalog } from '../offline/cloudBootstrap'
import { getAllProducts, getProductByBarcode } from '../offline/productRepository'
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

let runtimePromise

function toQuickLoginAccount(record) {
  const email = String(record?.email || '').trim()
  const name = String(record?.name || '').trim()
  return {
    id: record.id,
    email,
    name: name || email.split('@')[0] || 'Cashier',
  }
}

function toCachedQuickLoginAccount(record) {
  return {
    id: record.id,
    email: String(record.email || '').trim(),
    name: String(record.name || '').trim() || String(record.email || '').trim().split('@')[0] || 'Cashier',
    role: record.role || 'cashier',
    status: record.status || 'active',
    quickLoginEnabled: Boolean(record.quickLoginEnabled ?? record.quick_login_enabled),
  }
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
    .filter((account) => account.role === 'cashier' && account.status === 'active' && account.quickLoginEnabled)
    .toArray()
    .then((records) => records.map(toQuickLoginAccount))
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

function toCashierSale(sale, pendingIds = new Set()) {
  const adjusted = Array.isArray(sale.adjustments) && sale.adjustments.length > 0
  return {
    id: sale.clientSaleId,
    saleId: sale.clientSaleId,
    transactionNo: sale.transactionNo,
    totalAmount: sale.totalAmount,
    subtotalAmount: sale.subtotalAmount,
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod: sale.paymentMethod,
    refNumber: sale.refNumber || '',
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

async function authorizeManagerApproval(authorization = {}) {
  const payload = typeof authorization === 'string' ? { code: authorization } : authorization
  const code = String(payload?.code || '').trim()
  const email = String(payload?.email || '').trim()
  const password = String(payload?.password || '')
  const activeRuntime = await runtime()

  if (code) {
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
      activeRuntime.pb.filter('void_barcode = {:code} && role = "admin"', { code }),
      { requestKey: null },
    ).catch(() => null)

    if (legacyManager) {
      return {
        id: legacyManager.id,
        name: legacyManager.name || legacyManager.email || 'Manager',
        email: legacyManager.email || '',
        method: 'barcode',
      }
    }
  }

  if (email && password) {
    const adminClient = new PocketBase(import.meta.env.VITE_POCKETBASE_URL)
    adminClient.autoCancellation(false)
    const auth = await adminClient.collection('users').authWithPassword(email, password)
    const admin = auth.record

    if (admin?.role !== 'admin') throw new Error('Only admin accounts can approve completed transaction voids.')
    if (admin?.status === 'inactive') throw new Error('This admin account is inactive.')

    return {
      id: admin.id,
      name: admin.name || admin.email || 'Manager',
      email: admin.email || '',
      method: 'password',
    }
  }

  throw new Error('Manager approval requires a barcode or admin email and password.')
}

export const desktopCashierApi = {
  async currentUser() {
    const activeRuntime = await runtime()
    return activeRuntime.pb.authStore.isValid ? activeRuntime.pb.authStore.record : null
  },

  async login(email, password) {
    const activeRuntime = await runtime()
    const auth = await activeRuntime.login(email, password)
    if (auth.record?.role !== 'cashier') {
      activeRuntime.logout()
      throw new Error('Only cashier accounts can access this area.')
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
      fields: 'id,name,email,role,status,quick_login_enabled',
      sort: 'name',
      requestKey: null,
    }).then(cacheQuickLoginAccounts).catch(() => {})
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
    await initializeCashierDb()
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      return cachedQuickLoginAccounts()
    }
    const activeRuntime = await runtime()
    return activeRuntime.pb.collection('users').getFullList({
      filter: 'role = "cashier" && quick_login_enabled = true && status != "inactive"',
      fields: 'id,name,email,role,status,quick_login_enabled',
      sort: 'name',
      requestKey: null,
    })
      .then(async (records) => {
        await cacheQuickLoginAccounts(records)
        return records.map(toQuickLoginAccount).filter((account) => account.email)
      })
      .catch(() => cachedQuickLoginAccounts())
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
      .map((sale) => toCashierSale(sale, pendingIds))
  },

  async saleLookup({ transactionNo }) {
    const sale = await findLocalSaleByTransactionNo(transactionNo)
    if (!sale) throw new Error(`No completed transaction found for "${transactionNo}".`)
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
    return activeRuntime.syncEngine.syncNow()
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
            await activeRuntime.pb.collection('products').update(product.id, {
              quantity: (Number(product.quantity) || 0) + (Number(item.quantity_sold) || 0),
            }, { requestKey: null })
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
          await activeRuntime.pb.collection('products').update(product.id, {
            quantity: (Number(product.quantity) || 0) + quantity,
          }, { requestKey: null })
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
