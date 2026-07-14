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
import { activityLogPayloadForSync } from './activityLogSync'

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
  const base = error instanceof Error ? error.message : String(error)
  const response = error?.response || error?.data || {}
  const fields = response?.data || {}
  const details = Object.entries(fields)
    .map(([field, value]) => `${field}: ${value?.message || value?.code || String(value)}`)
  const responseMessage = typeof response?.message === 'string' ? response.message.trim() : ''
  const message = responseMessage && responseMessage !== base ? `${base}: ${responseMessage}` : base
  return details.length ? `${message} (${details.join('; ')})` : message
}

function isPocketBaseRecordId(value) {
  return /^[a-z0-9]{15}$/.test(String(value || '').trim())
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
    if (await findStockMovement(pb, productId, movementReference)) {
      // A retry may find the durable movement after another sync process has
      // already handled the sale. Reconcile instead of trusting a possibly
      // stale product snapshot cached before that upload finished.
      await reconcileProductStock(pb, productId)
      continue
    }
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

  async isCloudReachable({ forceNetworkCheck = false } = {}) {
    if (!forceNetworkCheck && globalThis.navigator && !globalThis.navigator.onLine) return false
    if (!forceNetworkCheck && isPocketBaseRateLimited()) return false

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

  async runSync({ forceProductRefresh = false, forceNetworkCheck = false } = {}) {
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
    const operationNeedsCatalog = queuedOps.some((operation) => (
      operation.type === 'voidCompletedSale' || operation.type === 'adjustCompletedSale'
    ))
    const hasQueuedWrites = queuedSales.length > 0 || queuedOps.length > 0
    const shouldRefreshProducts = forceProductRefresh
      || queuedSales.length > 0
      || operationNeedsCatalog
      || (!hasQueuedWrites && now - this.lastProductRefreshAt >= PRODUCT_REFRESH_INTERVAL_MS)

    if (!hasQueuedWrites && !shouldRefreshProducts) {
      return { uploaded: 0, failed: 0, products: 0, pending: await this.pendingCount() }
    }

    if ((queuedSales.length > 0 || queuedOps.length > 0) && this.pb.authStore && !this.pb.authStore.isValid) {
      const warning = 'Internet is connected, but this cashier session has no cloud authorization. Sign out, sign in once with the cashier email and password, then press Sync.'
      emitSyncStatus('auth-required', warning)
      return {
        uploaded: 0,
        failed: 0,
        products: 0,
        warnings: [warning],
        pending: await this.pendingCount(),
      }
    }

    // Manual sync should attempt the actual queued writes even when WebView2's
    // navigator/health probe reports offline. The write failure itself is the
    // authoritative connectivity check and safely leaves the item queued.
    if (!forceNetworkCheck && !(await this.isCloudReachable())) {
      emitSyncStatus('offline', `Offline — ${queuedSales.length + queuedOps.length} operation(s) waiting to sync`)
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0, products: 0, pending: await this.pendingCount() }
    }

    emitSyncStatus('running', 'Auto-Sync Running')

    let uploaded = 0
    let failed = 0
    let products = 0
    const warnings = []

    if (shouldRefreshProducts) {
      try {
        products = await refreshLocalProductCatalog({ pb: this.pb })
        this.lastProductRefreshAt = Date.now()
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        warnings.push(errorMessage(error))
        this.dispatchEvent(new CustomEvent('catalogrefresherror', {
          detail: { error },
        }))
      }
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

    const pending = await this.pendingCount()
    this.dispatchEvent(new CustomEvent('synccomplete', {
      detail: { uploaded, failed, warnings },
    }))
    emitSyncStatus(
      failed > 0 ? 'failed' : pending > 0 ? 'waiting' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed`
        : pending > 0
          ? `Auto-Sync Waiting — ${pending} pending`
          : 'Auto-Sync Succeeded — 0 pending',
    )
    return { uploaded, failed, products, warnings, pending }
  }

  async pendingCount() {
    return (await cashierDb.pendingSales.count()) + (await cashierDb.pendingOps.count())
  }

  async cloudSessionId(localId) {
    if (!localId) return ''
    const mapping = await cashierDb.settings.get(`cashSession:${localId}`)
    return mapping?.value || (String(localId).startsWith('shift_') ? '' : localId)
  }

  async resolveCloudCashSession(localId, payload = {}) {
    const mappedId = await this.cloudSessionId(localId)
    const validMappedId = await this.existingRelationId('cash_register_sessions', mappedId)
    if (validMappedId) return validMappedId

    const deviceId = String(payload.device_id || '').trim()
    if (!deviceId) return ''

    const result = await this.pb.collection('cash_register_sessions').getList(1, 20, {
      filter: this.pb.filter('device_id = {:deviceId}', { deviceId }),
      sort: '-opened_at',
      fields: 'id,status,opened_at,closed_at',
      requestKey: null,
    }).catch(() => null)
    const sessions = result?.items || []
    const closeTime = Date.parse(payload.closed_at || '')
    const eligible = Number.isFinite(closeTime)
      ? sessions.filter((session) => {
        const openedAt = Date.parse(session.opened_at || '')
        return !Number.isFinite(openedAt) || openedAt <= closeTime
      })
      : sessions
    const recovered = eligible.find((session) => session.status === 'open') || eligible[0]
    if (!recovered?.id) return ''

    if (localId) {
      await cashierDb.settings.put({ key: `cashSession:${localId}`, value: recovered.id })
    }
    return recovered.id
  }

  async recreateMissingCashSession(localId, payload = {}, requestKey = '') {
    let history
    try {
      const parsed = JSON.parse(globalThis.localStorage?.getItem('nexa_cashier_cash_count_history') || '[]')
      history = Array.isArray(parsed) ? parsed : []
    } catch {
      history = []
    }

    const deviceId = String(payload.device_id || '').trim()
    const closedAt = payload.closed_at || new Date().toISOString()
    const closedTime = Date.parse(closedAt)
    const matchingHistory = history
      .filter((entry) => !deviceId || String(entry.deviceId || '').trim() === deviceId)
      .sort((a, b) => (
        Math.abs(Date.parse(a.countedAt || '') - closedTime)
        - Math.abs(Date.parse(b.countedAt || '') - closedTime)
      ))[0]
    const cashierId = await this.resolveCashierId(payload.cashier_id || matchingHistory?.cashierId).catch(() => '')
    if (!cashierId) return ''

    const fallbackOpenedAt = Number.isFinite(closedTime)
      ? new Date(Math.max(0, closedTime - 1000)).toISOString()
      : new Date().toISOString()
    const recoveredPayload = {
      cashier_id: cashierId,
      opening_amount: numberFieldValue(payload.opening_amount ?? matchingHistory?.openingAmount),
      closing_amount: numberFieldValue(payload.closing_amount ?? matchingHistory?.actualCash),
      expected_closing_amount: numberFieldValue(payload.expected_closing_amount ?? matchingHistory?.expectedCash),
      actual_closing_amount: numberFieldValue(payload.actual_closing_amount ?? matchingHistory?.actualCash),
      variance: Number(payload.variance ?? matchingHistory?.variance) || 0,
      cash_in_total: numberFieldValue(payload.cash_in_total ?? matchingHistory?.cashIn),
      cash_out_total: numberFieldValue(payload.cash_out_total ?? matchingHistory?.cashOut),
      status: 'closed',
      opened_at: payload.opened_at || matchingHistory?.openedAt || fallbackOpenedAt,
      closed_at: closedAt,
      notes: [String(payload.notes || '').trim(), 'Recovered from this terminal after the original cloud drawer session was unavailable.'].filter(Boolean).join(' '),
      device_id: deviceId,
    }
    const created = await this.pb.collection('cash_register_sessions').create(recoveredPayload, {
      requestKey: `${requestKey || localId}:recovered-session`,
    }).catch(() => null)
    if (!created?.id) return ''
    if (localId) await cashierDb.settings.put({ key: `cashSession:${localId}`, value: created.id })
    return created.id
  }

  async existingRelationId(collection, value) {
    if (!isPocketBaseRecordId(value)) return ''
    const record = await this.pb.collection(collection).getOne(value, {
      fields: 'id',
      requestKey: null,
    }).catch(() => null)
    return record?.id || ''
  }

  async resolveCashierId(value) {
    const original = await this.existingRelationId('users', value)
    if (original) return original

    // A cashier can be deleted and recreated in PocketBase while this terminal
    // still has operations queued under the old record ID. Recover the stable
    // identity from the local login/sync cache and match the replacement cloud
    // account by email. This also works while an administrator runs Sync Center.
    const [quickLogin, syncCredential, settings] = await Promise.all([
      cashierDb.quickLoginAccounts.get(String(value || '')).catch(() => null),
      cashierDb.settings.get(`cashierSyncAuth:${String(value || '')}`).catch(() => null),
      cashierDb.settings.toArray().catch(() => []),
    ])
    const cachedLogin = settings.find((setting) => (
      String(setting.key || '').startsWith('cashierLogin:')
      && setting.value?.user?.id === value
    ))
    const cachedUser = quickLogin || syncCredential?.value?.user || cachedLogin?.value?.user
    const email = String(cachedUser?.email || '').trim().toLowerCase()
    if (email) {
      const replacement = await this.pb.collection('users').getFirstListItem(
        this.pb.filter('email = {:email} && role = "cashier" && status != "inactive"', { email }),
        { fields: 'id', requestKey: null },
      ).catch(() => null)
      if (replacement?.id) return replacement.id
    }

    const authenticated = this.pb.authStore?.record
    if (authenticated?.role === 'cashier' && authenticated?.status !== 'inactive') {
      const current = await this.existingRelationId('users', authenticated.id)
      if (current) return current
    }

    throw new Error('The queued cashier account no longer exists. Sign out, then sign in with an active cashier account and sync again.')
  }

  async resolveCashMovementCashier(payload, sessionId) {
    const directCashier = await this.existingRelationId('users', payload.cashier_id)
    if (directCashier) return directCashier

    if (sessionId) {
      const session = await this.pb.collection('cash_register_sessions').getOne(sessionId, {
        fields: 'cashier_id',
        requestKey: null,
      }).catch(() => null)
      const sessionCashier = await this.existingRelationId('users', session?.cashier_id)
      if (sessionCashier) return sessionCashier
    }

    const deviceId = String(payload.device_id || '').trim()
    if (deviceId) {
      const sessions = await this.pb.collection('cash_register_sessions').getList(1, 1, {
        filter: this.pb.filter('device_id = {:deviceId}', { deviceId }),
        sort: '-opened_at',
        fields: 'cashier_id',
        requestKey: null,
      }).catch(() => null)
      const terminalCashier = await this.existingRelationId('users', sessions?.items?.[0]?.cashier_id)
      if (terminalCashier) return terminalCashier
    }

    const recoveredCashier = await this.resolveCashierId(payload.cashier_id).catch(() => '')
    if (recoveredCashier) return recoveredCashier

    throw new Error('The cashier account for this cash movement no longer exists, and no matching drawer session could be found.')
  }

  async uploadOperation(op) {
    const payload = { ...(op.payload || {}) }
    const localSessionId = payload.localSessionId || payload.sessionId || ''
    delete payload.localSessionId
    delete payload.sessionId
    const cloudSessionId = await this.cloudSessionId(localSessionId)
    if (cloudSessionId) payload.session_id = cloudSessionId

    if (op.type === 'openCashRegisterSession') {
      payload.cashier_id = await this.resolveCashierId(payload.cashier_id)
      const created = await this.pb.collection('cash_register_sessions').create(payload, { requestKey: op.id })
      await cashierDb.settings.put({ key: `cashSession:${op.entityId}`, value: created.id })
    } else if (op.type === 'closeCashRegisterSession') {
      let resolvedSessionId = await this.resolveCloudCashSession(localSessionId, payload)
      let recreatedSession = false
      if (!resolvedSessionId) {
        resolvedSessionId = await this.recreateMissingCashSession(localSessionId, payload, op.id)
        recreatedSession = Boolean(resolvedSessionId)
      }
      if (!resolvedSessionId) {
        throw new Error('The original drawer session could not be recovered because its cashier identity is unavailable. Sign in once with the cashier account, then retry.')
      }
      delete payload.session_id
      if (!recreatedSession) {
        await this.pb.collection('cash_register_sessions').update(resolvedSessionId, payload, { requestKey: op.id })
      }
    } else if (op.type === 'recordCashMovement') {
      // Older queued movements may contain a synthetic developer approver ID
      // or a stale/deleted cloud relation. Both relations are optional, so
      // retain them only when the referenced cloud record still exists.
      const [approvedBy, sessionId] = await Promise.all([
        this.existingRelationId('users', payload.approved_by),
        this.existingRelationId('cash_register_sessions', payload.session_id),
      ])
      payload.cashier_id = await this.resolveCashMovementCashier(payload, sessionId)
      if (approvedBy) payload.approved_by = approvedBy
      else delete payload.approved_by
      if (sessionId) payload.session_id = sessionId
      else delete payload.session_id
      payload.category = String(payload.category || '').slice(0, 120)
      payload.device_id = String(payload.device_id || '').slice(0, 80)
      try {
        await this.pb.collection('cash_movements').create(payload, { requestKey: op.id })
      } catch (error) {
        // Older app versions could queue metadata that no longer matches the
        // deployed collection. Retry validation failures with the immutable
        // audit essentials so a valid cash movement is never blocked forever
        // by optional legacy fields.
        if (error?.status !== 400) throw error
        await this.pb.collection('cash_movements').create({
          cashier_id: payload.cashier_id,
          type: payload.type === 'in' ? 'in' : 'out',
          amount: numberFieldValue(payload.amount),
          created_at: payload.created_at || new Date().toISOString(),
        }, { requestKey: `${op.id}:minimal` })
      }
    } else if (op.type === 'recordCashAudit') {
      payload.cashier_id = await this.resolveCashierId(payload.cashier_id)
      const sessionId = await this.existingRelationId('cash_register_sessions', payload.session_id)
      if (sessionId) payload.session_id = sessionId
      else delete payload.session_id
      await this.pb.collection('cash_audits').create(payload, { requestKey: op.id })
    } else if (op.type === 'activityLog') {
      const activityPayload = await activityLogPayloadForSync(
        payload,
        (userId) => this.existingRelationId('users', userId),
      )
      await this.pb.collection('activity_logs').create(activityPayload, { requestKey: op.id })
    } else if (op.type === 'voidCompletedSale' || op.type === 'adjustCompletedSale') {
      const sale = await this.pb.collection('sales').getFirstListItem(
        this.pb.filter('transaction_no = {:transactionNo} && cashier_id = {:cashierId}', {
          transactionNo: payload.transactionNo,
          cashierId: payload.cashierId,
        }),
        { requestKey: null },
      )
      for (const item of (op.type === 'adjustCompletedSale' && payload.restock === false) ? [] : (payload.items || [])) {
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
    const cashierId = await this.resolveCashierId(sale.cashierId)
    const resolvedSale = cashierId === sale.cashierId ? sale : { ...sale, cashierId }
    let cloudSale
    try {
      cloudSale = await this.pb.collection('sales').create(cloudSalePayload(resolvedSale), {
        requestKey: `sale:${resolvedSale.clientSaleId}`,
      })
    } catch (error) {
      if (error?.status !== 400 && error?.status !== 409) throw error

      cloudSale = await findExistingCloudSale(this.pb, resolvedSale)

      if (!cloudSale) throw error
    }

    const { items: cloudSaleItems } = await ensureCloudSaleItems(this.pb, resolvedSale, cloudSale)
    // Always verify the stock movement. A previous attempt may have created
    // the sale and line items but failed before deducting inventory. The
    // movement reference check inside ensureCloudStockDeduction keeps retries
    // idempotent and applies the converted base-unit quantity exactly once.
    await ensureCloudStockDeduction(this.pb, resolvedSale, cloudSaleItems)

    const detail = saleActivityDetail(resolvedSale)
    const existingLog = await this.pb.collection('activity_logs').getFirstListItem(
      this.pb.filter('user_id = {:cashierId} && action_type = "Sale" && description = {:detail}', {
        cashierId: resolvedSale.cashierId,
        detail,
      }),
      { requestKey: null },
    ).catch(() => null)

    if (!existingLog) {
      await this.pb.collection('activity_logs').create({
        user_id: resolvedSale.cashierId,
        action_type: 'Sale',
        description: detail,
        timestamp: resolvedSale.createdAt || new Date().toISOString(),
      }, { requestKey: `activity:${resolvedSale.clientSaleId}` }).catch(() => null)
    }

    if (Number(sale.discountAmount) > 0 || Number(sale.discountPercent) > 0) {
      const discountDetail = `Applied ${Number(sale.discountPercent || 0)}% discount (${Number(sale.discountAmount || 0).toFixed(2)} off ${Number(sale.subtotalAmount || sale.totalAmount || 0).toFixed(2)}) on transaction ${sale.transactionNo}`
      const existingDiscountLog = await this.pb.collection('activity_logs').getFirstListItem(
        this.pb.filter('user_id = {:cashierId} && action_type = "Discount" && description = {:detail}', {
          cashierId: resolvedSale.cashierId,
          detail: discountDetail,
        }),
        { requestKey: null },
      ).catch(() => null)

      if (!existingDiscountLog) {
        await this.pb.collection('activity_logs').create({
          user_id: resolvedSale.cashierId,
          action_type: 'Discount',
          description: discountDetail,
          timestamp: resolvedSale.createdAt || new Date().toISOString(),
        }, { requestKey: `discount:${resolvedSale.clientSaleId}` }).catch(() => null)
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
