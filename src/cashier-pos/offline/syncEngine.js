import PocketBase from 'pocketbase'
import { cashierDb } from './db'
import { refreshLocalProductCatalog } from './cloudBootstrap'
import { toBaseStockQuantity } from './stockUtils'
import {
  isPocketBaseRateLimited,
  pocketBaseRateLimitRemainingMs,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { findStockMovement, reconcileProductStock } from '../../utils/stockMovementReconciler'

const DEFAULT_INTERVAL_MS = 60_000
const PRODUCT_REFRESH_INTERVAL_MS = 2 * 60_000
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
    subtotal_amount: sale.subtotalAmount,
    discount_percent: sale.discountPercent,
    discount_amount: sale.discountAmount,
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
    let productId = String(item.productId || '').trim()
    if (productId) {
      // verify product exists in cloud
      try {
        await pb.collection('products').getOne(productId, { requestKey: null })
      } catch {
        productId = ''
      }
    }

    // fallback: resolve by barcode if productId missing
    if (!productId && String(item.barcode || '').trim()) {
      const normalized = String(item.barcode || '').trim()
      try {
        const cloudProducts = await pb.collection('products').getFullList({ requestKey: null }).catch(() => [])
        const matched = cloudProducts.find((p) => (
          String(p.barcode || '').trim() === normalized
          || (Array.isArray(p.selling_units) && p.selling_units.some((u) => String(u?.barcode || '').trim() === normalized))
        ))
        if (matched) productId = String(matched.id)
      } catch {
        // ignore and proceed
      }
    }

    // attempt to create sale_item; if productId still missing, try without product relation
    const payload = {
      sale_id: cloudSale.id,
      product_id: productId || null,
      quantity_sold: Number(item.quantity) || 0,
      price_at_sale: Number(item.price) || 0,
    }

    try {
      const created = await pb.collection('sale_items').create(payload, {
        requestKey: `sale-item:${sale.clientSaleId}:${productId || 'unknown'}`,
      })
      createdItems.push(created)
    } catch {
      // If creation failed due to invalid product relation, try removing product_id
      const fallback = { ...payload, product_id: null }
      const created = await pb.collection('sale_items').create(fallback, {
        requestKey: `sale-item-fallback:${sale.clientSaleId}:${Date.now()}`,
      })
      createdItems.push(created)
    }
  }

  return { items: createdItems, createdNow: true }
}

async function ensureCloudStockDeduction(pb, sale, cloudSaleItems) {
  for (const item of sale.items) {
    const productId = String(item.productId || '').trim()
    if (!productId) continue

    const product = await pb.collection('products').getOne(productId, { requestKey: null })
    const previousQuantity = Number(product.quantity) || 0
    const matchingSaleItems = cloudSaleItems.filter((saleItem) => {
      const saleItemProductId = Array.isArray(saleItem.product_id) ? saleItem.product_id[0] : saleItem.product_id
      return saleItemProductId === productId
    })
    const syncedQty = matchingSaleItems.reduce((sum, saleItem) => sum + (Number(saleItem.quantity_sold) || 0), 0)
    const baseQuantityToDeduct = toBaseStockQuantity(Number(item.quantity) || 0, Number(item.conversion) || 1)
    const effectiveQtyToDeduct = Math.max(baseQuantityToDeduct, syncedQty)
    const movementReference = `sale:${sale.clientSaleId}:${productId}`
    if (await findStockMovement(pb, productId, movementReference)) continue
    const nextQuantity = Math.max(0, previousQuantity - effectiveQtyToDeduct)

    await pb.collection('products').update(product.id, {
      quantity: numberFieldValue(nextQuantity),
    }, {
      requestKey: `product-stock:${sale.clientSaleId}:${productId}`,
    })
    await pb.collection('stock_movements').create({
      product_id: product.id,
      movement_type: 'sale',
      quantity: effectiveQtyToDeduct,
      previous_quantity: previousQuantity,
      new_quantity: nextQuantity,
      reference_type: 'sale',
      reference_id: movementReference,
      notes: `Sale ${sale.transactionNo}`,
      user_id: sale.cashierId,
      created_at: sale.createdAt || new Date().toISOString(),
    }, {
      requestKey: `stock-movement:sale:${sale.clientSaleId}:${productId}`,
    })
    await reconcileProductStock(pb, product.id)
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
    const queuedOps = await cashierDb.pendingOps
      .where('status')
      .equals('pending')
      .filter((op) => (Number(op.nextAttemptAt) || 0) <= now)
      .sortBy('createdAt')
    const shouldRefreshProducts = forceProductRefresh
      || queuedSales.length > 0
      || queuedOps.length > 0
      || now - this.lastProductRefreshAt >= PRODUCT_REFRESH_INTERVAL_MS

    if (queuedSales.length === 0 && !shouldRefreshProducts) {
      return { uploaded: 0, failed: 0, products: 0, pending: await this.pendingCount() }
    }

    if (!(await this.isCloudReachable())) {
      emitSyncStatus('offline', `Offline — ${queuedSales.length + queuedOps.length} operation(s) waiting to sync`)
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0, products: 0, pending: await this.pendingCount() }
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

    for (const op of queuedOps) {
      if (this.stopped) break
      try {
        await this.uploadOperation(op)
        uploaded += 1
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        failed += 1
        const attempts = op.attempts + 1
        await cashierDb.pendingOps.update(op.id, {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: errorMessage(error),
          nextAttemptAt: Date.now() + retryDelay(attempts),
        })
      }
    }

    this.dispatchEvent(new CustomEvent('synccomplete', {
      detail: { uploaded, failed },
    }))
    emitSyncStatus(
      failed > 0 ? 'failed' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed`
        : `Auto-Sync Succeeded — ${await this.pendingCount()} pending`,
    )
    return { uploaded, failed, products, pending: await this.pendingCount() }
  }

  async pendingCount() {
    return (await cashierDb.pendingSales.count()) + (await cashierDb.pendingOps.count())
  }

  async cloudSessionId(localId) {
    if (!localId) return ''
    const mapping = await cashierDb.settings.get(`cashSession:${localId}`)
    return mapping?.value || (String(localId).startsWith('shift_') ? '' : localId)
  }

  async uploadOperation(op) {
    const payload = { ...(op.payload || {}) }
    const localSessionId = payload.localSessionId || payload.sessionId || ''
    delete payload.localSessionId
    delete payload.sessionId
    const cloudSessionId = await this.cloudSessionId(localSessionId)
    if (cloudSessionId) payload.session_id = cloudSessionId

    if (op.type === 'openCashRegisterSession') {
      const created = await this.pb.collection('cash_register_sessions').create(payload, { requestKey: op.id })
      await cashierDb.settings.put({ key: `cashSession:${op.entityId}`, value: created.id })
    } else if (op.type === 'closeCashRegisterSession') {
      if (!cloudSessionId) throw new Error('Opening cash session has not synchronized yet.')
      await this.pb.collection('cash_register_sessions').update(cloudSessionId, payload, { requestKey: op.id })
    } else if (op.type === 'recordCashMovement') {
      await this.pb.collection('cash_movements').create(payload, { requestKey: op.id })
    } else if (op.type === 'recordCashAudit') {
      await this.pb.collection('cash_audits').create(payload, { requestKey: op.id })
    } else if (op.type === 'activityLog') {
      await this.pb.collection('activity_logs').create(payload, { requestKey: op.id })
    } else if (op.type === 'voidCompletedSale' || op.type === 'adjustCompletedSale') {
      const sale = await this.pb.collection('sales').getFirstListItem(
        this.pb.filter('transaction_no = {:transactionNo} && cashier_id = {:cashierId}', {
          transactionNo: payload.transactionNo,
          cashierId: payload.cashierId,
        }),
        { requestKey: null },
      )
      for (const item of payload.items || []) {
          const productId = String(item.productId || item.id || '')
          if (!productId) continue
          const existingMovement = await this.pb.collection('stock_movements').getFirstListItem(
            this.pb.filter('reference_id = {:referenceId} && product_id = {:productId}', { referenceId: op.id, productId }),
            { requestKey: null },
          ).catch(() => null)
          if (existingMovement) continue
          const returnedQuantity = toBaseStockQuantity(Number(item.quantity) || 0, Number(item.conversion) || 1)
          if (returnedQuantity <= 0) continue
          const product = await this.pb.collection('products').getOne(productId, { requestKey: null })
          const previousQuantity = Number(product.quantity) || 0
          const nextQuantity = previousQuantity + returnedQuantity
          await this.pb.collection('products').update(product.id, { quantity: numberFieldValue(nextQuantity) }, { requestKey: `${op.id}:${productId}:stock` })
          await this.pb.collection('stock_movements').create({
            product_id: product.id,
            movement_type: op.type === 'voidCompletedSale' ? 'void_return' : payload.type === 'exchange' ? 'exchange_return' : 'refund_return',
            quantity: returnedQuantity,
            previous_quantity: previousQuantity,
            new_quantity: nextQuantity,
            reference_type: op.type === 'voidCompletedSale' ? 'void' : payload.type,
            reference_id: op.id,
            notes: `${op.type === 'voidCompletedSale' ? 'Void' : payload.type} ${payload.transactionNo}${payload.reason ? `: ${payload.reason}` : ''}`,
            user_id: payload.cashierId,
            created_at: payload.createdAt || new Date().toISOString(),
          }, { requestKey: `${op.id}:${productId}:movement` })
          await reconcileProductStock(this.pb, product.id)
      }
      await this.pb.collection('sales').update(sale.id, {
        status: op.type === 'voidCompletedSale' ? 'voided' : 'adjusted',
        ...(op.type === 'voidCompletedSale' && payload.approverId ? { voided_by: payload.approverId } : {}),
      }, { requestKey: `${op.id}:sale` })
    } else {
      throw new Error(`Unknown cashier operation: ${op.type}`)
    }
    await cashierDb.pendingOps.delete(op.id)
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
