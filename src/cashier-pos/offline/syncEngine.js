import PocketBase from 'pocketbase'
import { cashierDb } from './db'
import { refreshLocalProductCatalog } from './cloudBootstrap'
import { toBaseStockQuantity } from './stockUtils'
import {
  isPocketBaseRateLimited,
  pocketBaseRateLimitRemainingMs,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'

const DEFAULT_INTERVAL_MS = 60_000
const PRODUCT_REFRESH_INTERVAL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, number) : 0)
}

function emitSyncStatus(state, message) {
  globalThis.dispatchEvent?.(new CustomEvent('nexa-sync-status', {
    detail: {
      scope: 'cashier',
      state,
      message,
    },
  }))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function retryDelay(attempts) {
  const exponential = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempts, 8)))
  return exponential + Math.floor(Math.random() * 500)
}

function cloudSalePayload(sale) {
  return {
    transaction_no: sale.transactionNo,
    cashier_id: sale.cashierId,
    total_amount: sale.totalAmount,
    payment_method: sale.paymentMethod,
    ref_number: sale.refNumber,
    status: 'completed',
    created_at: sale.createdAt,
  }
}

function saleActivityDetail(sale) {
  const itemCount = sale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const discount = Number(sale.discountAmount) || 0
  const suffix = discount > 0
    ? ` Discount: ${Number(sale.discountPercent || 0)}% / PHP ${discount.toFixed(2)}.`
    : ''
  return `Completed transaction ${sale.transactionNo} with ${itemCount} item(s), total PHP ${Number(sale.totalAmount || 0).toFixed(2)}.${suffix}`
}

async function ensureCloudSaleItems(pb, sale, cloudSale) {
  const existingItems = await pb.collection('sale_items').getFullList({
    filter: pb.filter('sale_id = {:saleId}', { saleId: cloudSale.id }),
    requestKey: null,
  }).catch(() => [])

  if (existingItems.length > 0) {
    return { items: existingItems, createdNow: false }
  }

  const createdItems = []
  for (const item of sale.items) {
    const created = await pb.collection('sale_items').create({
      sale_id: cloudSale.id,
      product_id: item.productId,
      quantity_sold: Number(item.quantity) || 0,
      price_at_sale: Number(item.price) || 0,
    }, {
      requestKey: `sale-item:${sale.clientSaleId}:${item.productId}`,
    })
    createdItems.push(created)
  }

  return { items: createdItems, createdNow: true }
}

async function ensureCloudStockDeduction(pb, sale, cloudSaleItems) {
  for (const item of sale.items) {
    const productId = String(item.productId || '').trim()
    if (!productId) continue

    const product = await pb.collection('products').getOne(productId, { requestKey: null })
    const matchingSaleItems = cloudSaleItems.filter((saleItem) => {
      const saleItemProductId = Array.isArray(saleItem.product_id) ? saleItem.product_id[0] : saleItem.product_id
      return saleItemProductId === productId
    })
    const syncedQty = matchingSaleItems.reduce((sum, saleItem) => sum + (Number(saleItem.quantity_sold) || 0), 0)
    const baseQuantityToDeduct = toBaseStockQuantity(Number(item.quantity) || 0, Number(item.conversion) || 1)
    const effectiveQtyToDeduct = Math.max(baseQuantityToDeduct, syncedQty)

    await pb.collection('products').update(product.id, {
      quantity: numberFieldValue((Number(product.quantity) || 0) - effectiveQtyToDeduct),
    }, {
      requestKey: `product-stock:${sale.clientSaleId}:${productId}`,
    })
  }
}

async function findExistingCloudSale(pb, sale) {
  const filters = [
    pb.filter('transaction_no = {:transactionNo} && cashier_id = {:cashierId}', {
      transactionNo: sale.transactionNo,
      cashierId: sale.cashierId,
    }),
  ]

  for (const filter of filters) {
    const found = await pb.collection('sales').getFirstListItem(filter, {
      requestKey: null,
    }).catch(() => null)
    if (found) return found
  }

  return null
}

export class CashierSyncEngine extends EventTarget {
  constructor({
    baseUrl = import.meta.env.VITE_POCKETBASE_URL,
    pb,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = {}) {
    super()
    if (!pb && !baseUrl) {
      throw new Error('VITE_POCKETBASE_URL or an authenticated PocketBase client is required.')
    }

    this.pb = pb || new PocketBase(baseUrl)
    this.pb.autoCancellation(false)
    this.intervalMs = intervalMs
    this.timer = null
    this.syncPromise = null
    this.stopped = true
    this.lastProductRefreshAt = 0
  }

  start() {
    if (!this.stopped) return
    this.stopped = false

    globalThis.addEventListener?.('online', this.handleOnline)
    this.schedule(0)
  }

  stop() {
    this.stopped = true
    globalThis.removeEventListener?.('online', this.handleOnline)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  handleOnline = () => {
    this.schedule(0)
  }

  schedule(delay = this.intervalMs) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const rateLimitDelay = pocketBaseRateLimitRemainingMs()
    this.timer = setTimeout(() => void this.syncNow(), Math.max(delay, rateLimitDelay))
  }

  async isCloudReachable() {
    if (globalThis.navigator && !globalThis.navigator.onLine) return false
    if (isPocketBaseRateLimited()) return false

    try {
      await this.pb.health.check({ requestKey: null })
      return true
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      return false
    }
  }

  async syncNow(options = {}) {
    if (this.syncPromise) return this.syncPromise

    this.syncPromise = this.runSync(options)
      .finally(() => {
        this.syncPromise = null
        this.schedule()
      })

    return this.syncPromise
  }

  async runSync({ forceProductRefresh = false } = {}) {
    const now = Date.now()
    const queuedSales = await cashierDb.pendingSales
      .where('status')
      .equals('pending')
      .filter((sale) => (Number(sale.nextAttemptAt) || 0) <= now)
      .sortBy('createdAt')
    const shouldRefreshProducts = forceProductRefresh
      || queuedSales.length > 0
      || now - this.lastProductRefreshAt >= PRODUCT_REFRESH_INTERVAL_MS

    if (queuedSales.length === 0 && !shouldRefreshProducts) {
      return { uploaded: 0, failed: 0, products: 0 }
    }

    if (!(await this.isCloudReachable())) {
      emitSyncStatus('offline', 'Auto-Sync Waiting for Connection')
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0, products: 0 }
    }

    emitSyncStatus('running', 'Auto-Sync Running')

    let uploaded = 0
    let failed = 0
    let products = 0

    try {
      products = await refreshLocalProductCatalog({ pb: this.pb })
      this.lastProductRefreshAt = Date.now()
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      failed += 1
      this.dispatchEvent(new CustomEvent('syncerror', {
        detail: { error },
      }))
    }

    for (const sale of queuedSales) {
      if (this.stopped) break

      try {
        await this.uploadSale(sale)
        uploaded += 1
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        failed += 1
        const attempts = sale.attempts + 1
        await cashierDb.pendingSales.update(sale.clientSaleId, {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: errorMessage(error),
          nextAttemptAt: Date.now() + retryDelay(attempts),
        })
        this.dispatchEvent(new CustomEvent('syncerror', {
          detail: { clientSaleId: sale.clientSaleId, error },
        }))
      }
    }

    this.dispatchEvent(new CustomEvent('synccomplete', {
      detail: { uploaded, failed },
    }))
    emitSyncStatus(
      failed > 0 ? 'failed' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed`
        : 'Auto-Sync Succeeded',
    )
    return { uploaded, failed, products }
  }

  async uploadSale(sale) {
    let cloudSale
    try {
      cloudSale = await this.pb.collection('sales').create(cloudSalePayload(sale), {
        requestKey: `sale:${sale.clientSaleId}`,
      })
    } catch (error) {
      if (error?.status !== 400 && error?.status !== 409) throw error

      cloudSale = await findExistingCloudSale(this.pb, sale)

      if (!cloudSale) throw error
    }

    const { items: cloudSaleItems, createdNow } = await ensureCloudSaleItems(this.pb, sale, cloudSale)
    if (createdNow) {
      await ensureCloudStockDeduction(this.pb, sale, cloudSaleItems)
    }

    const detail = saleActivityDetail(sale)
    const existingLog = await this.pb.collection('activity_logs').getFirstListItem(
      this.pb.filter('user_id = {:cashierId} && action_type = "Sale" && description = {:detail}', {
        cashierId: sale.cashierId,
        detail,
      }),
      { requestKey: null },
    ).catch(() => null)

    if (!existingLog) {
      await this.pb.collection('activity_logs').create({
        user_id: sale.cashierId,
        action_type: 'Sale',
        description: detail,
        timestamp: sale.createdAt || new Date().toISOString(),
      }, { requestKey: `activity:${sale.clientSaleId}` }).catch(() => null)
    }

    if (Number(sale.discountAmount) > 0 || Number(sale.discountPercent) > 0) {
      const discountDetail = `Applied ${Number(sale.discountPercent || 0)}% discount (${Number(sale.discountAmount || 0).toFixed(2)} off ${Number(sale.subtotalAmount || sale.totalAmount || 0).toFixed(2)}) on transaction ${sale.transactionNo}`
      const existingDiscountLog = await this.pb.collection('activity_logs').getFirstListItem(
        this.pb.filter('user_id = {:cashierId} && action_type = "Discount" && description = {:detail}', {
          cashierId: sale.cashierId,
          detail: discountDetail,
        }),
        { requestKey: null },
      ).catch(() => null)

      if (!existingDiscountLog) {
        await this.pb.collection('activity_logs').create({
          user_id: sale.cashierId,
          action_type: 'Discount',
          description: discountDetail,
          timestamp: sale.createdAt || new Date().toISOString(),
        }, { requestKey: `discount:${sale.clientSaleId}` }).catch(() => null)
      }
    }

    await cashierDb.pendingSales.delete(sale.clientSaleId)
    if (cashierDb.tables.some((table) => table.name === 'completedSales')) {
      await cashierDb.completedSales.update(sale.clientSaleId, { syncStatus: 'synced' })
    }
    this.dispatchEvent(new CustomEvent('salesynced', {
      detail: { clientSaleId: sale.clientSaleId },
    }))
  }
}
