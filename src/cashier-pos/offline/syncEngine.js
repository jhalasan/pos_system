import PocketBase from 'pocketbase'
import { cashierDb } from './db'
import { refreshLocalProductCatalog } from './cloudBootstrap'
import { toBaseStockQuantity } from './stockUtils'
import {
  isPocketBaseRateLimit,
  isPocketBaseRateLimited,
  pocketBaseRateLimitMessage,
  pocketBaseRateLimitRemainingMs,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { findExistingStockMovementsByReference, reconcileProductStock } from '../../utils/stockMovementReconciler'
import { activityLogPayloadForSync, minimalActivityLogPayload } from './activityLogSync'
import { quantizeQty } from '../../utils/quantity'
import { createPacedPocketBase } from '../../utils/pacedPocketBase'
import { sharedGovernor } from '../../utils/pocketbaseGovernorInstance'
import {
  activatePeakProtection,
  getPeakProtectionSettings,
  isPredictedPeak,
  peakProtectionStatus,
  protectAfterCloudPressure,
} from '../../utils/peakProtection'

const DEFAULT_INTERVAL_MS = 60_000
const PRODUCT_REFRESH_INTERVAL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10
// Mirrors admin-page/services/desktopApi.js's reachabilityCache: a plain
// health.check() on every sync cycle (every 60s, and again immediately
// after each completed sale) roughly doubled PocketHost request volume for
// no benefit — a positive check 15s ago is still true 15s later.
const REACHABILITY_SUCCESS_TTL_MS = 15_000
const REACHABILITY_FAILURE_TTL_MS = 8_000
// Spreads each terminal's steady-state 60s tick across up to 15s so a store
// running several terminals doesn't have them all call PocketHost in the
// same second. Fixed once per engine instance, not re-rolled per tick.
const SCHEDULE_JITTER_MS = 15_000
// M14: a catalog refresh that fails specifically because the session token
// expired used to be indistinguishable from any other refresh failure (a
// network blip, a genuine 500) -- both surfaced as a generic "Product
// catalog could not refresh: <raw error>" waiting-state message, which for
// an auth failure specifically reads as opaque ("Something went wrong")
// and never routes the cashier to the fix (the same message and UI path
// the pre-emptive queued-writes guard below already uses).
const CLOUD_AUTH_REQUIRED_MESSAGE = 'Internet is connected, but this cashier session has no cloud authorization. Sign out, sign in once with the cashier email and password, then press Sync.'

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, quantizeQty(number)) : 0)
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
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
  if (isPocketBaseRateLimit(error)) return pocketBaseRateLimitMessage()

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
    customer_name: String(sale.customerName || '').trim(),
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

// T3 (request-volume half): this used to verify each line's productId with
// its own pb.collection('products').getOne call, and — worse — re-fetched
// the ENTIRE product catalog from scratch inside the per-item loop for every
// line that needed the barcode fallback (so a 5-item sale with 3 barcode-only
// lines pulled the whole catalog 3 times). Both are now resolved once, up
// front, for the whole sale: one bulk existence check for every distinct
// productId the sale already has, and at most one catalog fetch (only if at
// least one line still needs the barcode fallback afterward), shared across
// every line that needs it.
async function resolveSaleItemProductIds(pb, items) {
  const declaredProductIds = [...new Set(
    items.map((item) => String(item.productId || '').trim()).filter(Boolean),
  )]

  const verifiedProductIds = new Set()
  if (declaredProductIds.length) {
    const filter = declaredProductIds
      .map((productId) => pb.filter('id = {:productId}', { productId }))
      .join(' || ')
    const found = await pb.collection('products').getFullList({ filter, requestKey: null }).catch(() => [])
    for (const product of found) verifiedProductIds.add(String(product.id))
  }

  const resolved = items.map((item) => {
    const declared = String(item.productId || '').trim()
    return { item, productId: declared && verifiedProductIds.has(declared) ? declared : '' }
  })

  const needsBarcodeFallback = resolved.some(({ item, productId }) => !productId && String(item.barcode || '').trim())
  if (needsBarcodeFallback) {
    const catalog = await pb.collection('products').getFullList({ requestKey: null }).catch(() => [])
    for (const entry of resolved) {
      if (entry.productId) continue
      const normalized = String(entry.item.barcode || '').trim()
      if (!normalized) continue
      const matched = catalog.find((p) => (
        String(p.barcode || '').trim() === normalized
        || (Array.isArray(p.selling_units) && p.selling_units.some((u) => String(u?.barcode || '').trim() === normalized))
      ))
      if (matched) entry.productId = String(matched.id)
    }
  }

  return resolved
}

async function ensureCloudSaleItems(pb, sale, cloudSale) {
  const existingItems = await pb.collection('sale_items').getFullList({
    filter: pb.filter('sale_id = {:saleId}', { saleId: cloudSale.id }),
    requestKey: null,
  }).catch(() => [])

  if (existingItems.length > 0) {
    return { items: existingItems, createdNow: false }
  }

  const resolved = await resolveSaleItemProductIds(pb, sale.items)

  const createdItems = []
  for (const { item, productId } of resolved) {
    // attempt to create sale_item; if productId still missing, try without product relation
    const lineKey = item.lineId || productId
    const payload = {
      sale_id: cloudSale.id,
      product_id: productId || null,
      quantity_sold: Number(item.quantity) || 0,
      price_at_sale: Number(item.price) || 0,
      // May be undefined against a PocketBase instance that hasn't run
      // scripts/add-sale-item-line-id.mjs yet — PocketBase silently ignores
      // unknown fields on create, so this is safe either way.
      line_id: item.lineId || undefined,
    }

    try {
      const created = await pb.collection('sale_items').create(payload, {
        requestKey: `sale-item:${sale.clientSaleId}:${lineKey || 'unknown'}`,
      })
      createdItems.push(created)
    } catch {
      // If creation failed due to invalid product relation, try removing product_id
      const fallback = { ...payload, product_id: null }
      const created = await pb.collection('sale_items').create(fallback, {
        requestKey: `sale-item-fallback:${sale.clientSaleId}:${lineKey || Date.now()}`,
      })
      createdItems.push(created)
    }
  }

  return { items: createdItems, createdNow: true }
}

// T3 (request-volume half): this used to run fully sequentially, once per
// line — its own findStockMovement lookup, its own products.getOne, its own
// products.update, its own reconcileProductStock (itself 2-3 requests) —
// even for two lines of the *same* product (one sold as a case, one loose;
// see the lineId comment below). That's ~5-6 requests per line regardless of
// how many lines actually shared a product. Now: one bulk lookup covers
// every line's "was this already deducted by an earlier, interrupted
// attempt" check, lines are grouped by product so a repeated product is
// fetched and updated exactly once (with its lines' deductions summed and
// applied as one update — see the runningQuantity chain below, which still
// gives every line its own correctly-chained stock_movements audit row), and
// reconcileProductStock runs once per distinct product touched, not once per
// line.
async function ensureCloudStockDeduction(pb, sale, cloudSaleItems) {
  // A line with no productId of its own (resolved instead via the barcode
  // fallback in ensureCloudSaleItems) used to be skipped here entirely --
  // this read item.productId directly off the raw sale data, which is still
  // whatever it originally was (often empty), not the productId that was
  // actually resolved and persisted onto the cloud sale_item. Prefer the
  // persisted cloud sale_item's product_id (matched by lineId) whenever one
  // exists; only fall back to the sale's own item.productId for legacy rows
  // that have no lineId to match by.
  const cloudItemsByLineId = new Map(
    cloudSaleItems.filter((cloudItem) => cloudItem.line_id).map((cloudItem) => [cloudItem.line_id, cloudItem]),
  )

  const lineEntries = sale.items
    .map((item) => {
      const cloudItem = item.lineId ? cloudItemsByLineId.get(item.lineId) : null
      const resolvedProductId = cloudItem
        ? String((Array.isArray(cloudItem.product_id) ? cloudItem.product_id[0] : cloudItem.product_id) || '').trim()
        : String(item.productId || '').trim()
      return { item, productId: resolvedProductId }
    })
    .filter(({ productId }) => productId)
    .map(({ item, productId }) => {
      // lineId gives each cart line its own identity, distinct from
      // productId — without it, two lines of the same product (e.g. one sold
      // as a case, one sold loose) shared a single productId-keyed movement
      // reference: creating the movement for line 1 made findStockMovement
      // report "already deducted" for line 2, silently skipping it. Sales
      // queued before this field existed have no lineId; those fall back to
      // the old productId-keyed behavior (and still need the syncedQty
      // fallback below, since without a lineId there is no way to tell their
      // sale_items row apart from another line of the same product either).
      const lineKey = item.lineId || productId
      return { item, productId, lineKey, movementReference: `sale:${sale.clientSaleId}:${lineKey}` }
    })

  if (!lineEntries.length) return

  const existingMovementsByReference = await findExistingStockMovementsByReference(
    pb,
    lineEntries.map((entry) => entry.movementReference),
  )

  const reconciledProductIds = new Set()
  const pendingByProduct = new Map()

  for (const entry of lineEntries) {
    if (existingMovementsByReference.has(entry.movementReference)) {
      // A retry may find the durable movement after another sync process has
      // already handled the sale. Reconcile instead of trusting a possibly
      // stale product snapshot cached before that upload finished.
      if (!reconciledProductIds.has(entry.productId)) {
        reconciledProductIds.add(entry.productId)
        await reconcileProductStock(pb, entry.productId)
      }
      continue
    }
    if (!pendingByProduct.has(entry.productId)) pendingByProduct.set(entry.productId, [])
    pendingByProduct.get(entry.productId).push(entry)
  }

  for (const [productId, entries] of pendingByProduct) {
    const product = await pb.collection('products').getOne(productId, { requestKey: null })
    let runningQuantity = quantizeQty(product.quantity)

    for (const { item, lineKey, movementReference } of entries) {
      const baseQuantityToDeduct = quantizeQty(toBaseStockQuantity(Number(item.quantity) || 0, Number(item.conversion) || 1))

      let effectiveQtyToDeduct = baseQuantityToDeduct
      if (!item.lineId) {
        // Legacy fallback only: without a lineId there's no reliable way to
        // match this specific line's own sale_items row, so fall back to the
        // old (unit-mismatched, but the previous behavior) heuristic of
        // trusting whichever is larger.
        const matchingSaleItems = cloudSaleItems.filter((saleItem) => {
          const saleItemProductId = Array.isArray(saleItem.product_id) ? saleItem.product_id[0] : saleItem.product_id
          return saleItemProductId === productId
        })
        const syncedQty = quantizeQty(matchingSaleItems.reduce((sum, saleItem) => sum + (Number(saleItem.quantity_sold) || 0), 0))
        effectiveQtyToDeduct = Math.max(baseQuantityToDeduct, syncedQty)
      }

      const previousQuantity = runningQuantity
      const nextQuantity = quantizeQty(Math.max(0, previousQuantity - effectiveQtyToDeduct))
      runningQuantity = nextQuantity

      await pb.collection('stock_movements').create({
        product_id: productId,
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
        requestKey: `stock-movement:sale:${sale.clientSaleId}:${lineKey}`,
      })
    }

    await pb.collection('products').update(productId, {
      quantity: numberFieldValue(runningQuantity),
    }, {
      requestKey: `product-stock:${sale.clientSaleId}:${productId}`,
    })
    reconciledProductIds.add(productId)
    await reconcileProductStock(pb, productId)
  }
}

// A transaction_no + cashier_id match alone used to be accepted as "this is
// the sale I just retried creating" — but transaction_no collisions were
// possible under the old generator (see transactionNumber.js), and even
// under the new one, matching on cashier_id + one field is thin corroboration
// for a write this consequential. Adopting the wrong record here means every
// subsequent item/stock write in uploadSale runs against someone else's
// sale. Requires amount and a same-day timestamp to also agree before
// treating a match as corroborated.
function isCorroboratedSaleMatch(found, sale) {
  if (!found) return false
  const amountMatches = Number(found.total_amount) === Number(sale.totalAmount)
  const foundTime = new Date(found.created_at || found.created || 0).getTime()
  const saleTime = new Date(sale.createdAt || 0).getTime()
  const withinOneDay = Number.isFinite(foundTime) && Number.isFinite(saleTime)
    && Math.abs(foundTime - saleTime) <= 24 * 60 * 60 * 1000
  return amountMatches && withinOneDay
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
    if (found && isCorroboratedSaleMatch(found, sale)) return found
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

    this.pb = pb || createPacedPocketBase(new PocketBase(baseUrl), sharedGovernor)
    this.pb.autoCancellation(false)
    this.intervalMs = intervalMs
    this.timer = null
    this.syncPromise = null
    this.stopped = true
    this.lastProductRefreshAt = 0
    this.catalogRefreshFailures = 0
    this.reachabilityCache = { value: false, expiresAt: 0 }
    this.jitterMs = Math.floor(Math.random() * SCHEDULE_JITTER_MS)
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
    this.reachabilityCache = { value: false, expiresAt: 0 }
    this.schedule(0)
  }

  schedule(delay = null) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const rateLimitDelay = pocketBaseRateLimitRemainingMs()
    const peakDelay = getPeakProtectionSettings().syncIntervalMinutes * 60_000
    const normalDelay = peakProtectionStatus().active ? peakDelay : this.intervalMs
    const requestedDelay = delay == null ? normalDelay + this.jitterMs : delay
    this.timer = setTimeout(() => void this.syncNow(), Math.max(requestedDelay, rateLimitDelay))
  }

  schedulePeakSync() {
    this.schedule(getPeakProtectionSettings().syncIntervalMinutes * 60_000 + this.jitterMs)
  }

  async isCloudReachable({ forceNetworkCheck = false } = {}) {
    if (!forceNetworkCheck && globalThis.navigator && !globalThis.navigator.onLine) return false
    if (!forceNetworkCheck && isPocketBaseRateLimited()) return false
    if (!forceNetworkCheck && Date.now() < this.reachabilityCache.expiresAt) return this.reachabilityCache.value

    try {
      await this.pb.health.check({ requestKey: null })
      this.reachabilityCache = { value: true, expiresAt: Date.now() + REACHABILITY_SUCCESS_TTL_MS }
      return true
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      this.reachabilityCache = { value: false, expiresAt: Date.now() + REACHABILITY_FAILURE_TTL_MS }
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
    let peakProtection = peakProtectionStatus({ now })
    if (!peakProtection.active && isPredictedPeak({ now })) {
      peakProtection = activatePeakProtection('A historically busy period is starting.', {
        pending: queuedSales.length,
        now,
      })
    }
    // A queued write unrelated to the catalog (e.g. a due-for-retry
    // recordCashMovement or activityLog op) must not starve the periodic
    // catalog refresh — that left a stale/partial catalog in place
    // indefinitely on any terminal with an unrelated op stuck in the queue.
    const shouldRefreshProducts = forceProductRefresh
      || operationNeedsCatalog
      || (!peakProtection.active && now - this.lastProductRefreshAt >= PRODUCT_REFRESH_INTERVAL_MS)

    if (!hasQueuedWrites && !shouldRefreshProducts) {
      return { uploaded: 0, failed: 0, products: 0, pending: await this.pendingCount() }
    }

    if ((queuedSales.length > 0 || queuedOps.length > 0) && this.pb.authStore && !this.pb.authStore.isValid) {
      emitSyncStatus('auth-required', CLOUD_AUTH_REQUIRED_MESSAGE)
      return {
        uploaded: 0,
        failed: 0,
        products: 0,
        warnings: [CLOUD_AUTH_REQUIRED_MESSAGE],
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
    let rateLimited = false
    let catalogRefreshFailed = false
    let catalogRefreshAuthFailed = false
    const warnings = []

    if (shouldRefreshProducts && !isPocketBaseRateLimited()) {
      try {
        products = await refreshLocalProductCatalog({ pb: this.pb })
        this.lastProductRefreshAt = Date.now()
        this.catalogRefreshFailures = 0
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        if (Number(error?.status) === 429) rateLimited = true
        if (Number(error?.status) === 429) protectAfterCloudPressure('PocketHost rate limit reached.', await this.pendingCount())
        catalogRefreshFailed = true
        // A 401, or the SDK having already invalidated the auth store in
        // response to this same request, means the session token expired --
        // the identical root cause the pre-emptive guard above already
        // detects, just discovered mid-request instead of before it. Route
        // it through the same auth-required message and UI path rather than
        // the generic "could not refresh: <raw error>" text below, which for
        // this specific cause is opaque (often literally "Something went
        // wrong") and never told the cashier what to actually do.
        if (Number(error?.status) === 401 || (this.pb.authStore && !this.pb.authStore.isValid)) {
          catalogRefreshAuthFailed = true
        }
        // A transient error should self-heal quickly rather than waiting out
        // the full 5-minute interval — but retrying on every single tick
        // forever (this used to just set lastProductRefreshAt = 0, making
        // the "due for refresh" check true again immediately) means a
        // catalog that's persistently failing to refresh burns a full
        // products.getFullList() every ~60s tick, indefinitely, with no
        // backoff. Capped exponential backoff instead: the first retry is
        // fast, later ones back off up to the same 5-minute ceiling as the
        // normal interval.
        this.catalogRefreshFailures += 1
        this.lastProductRefreshAt = Date.now() - PRODUCT_REFRESH_INTERVAL_MS + retryDelay(this.catalogRefreshFailures)
        warnings.push(catalogRefreshAuthFailed ? CLOUD_AUTH_REQUIRED_MESSAGE : errorMessage(error))
        this.dispatchEvent(new CustomEvent('catalogrefresherror', {
          detail: { error },
        }))
      }
    }

    for (const sale of queuedSales) {
      if (this.stopped) break
      if (rateLimited || isPocketBaseRateLimited()) { rateLimited = true; break }

      try {
        await this.uploadSale(sale)
        uploaded += 1
      } catch (error) {
        if (Number(error?.status) === 429) {
          rememberPocketBaseRateLimit(error)
          rateLimited = true
          await cashierDb.pendingSales.update(sale.clientSaleId, {
            lastError: pocketBaseRateLimitMessage(),
            nextAttemptAt: Date.now() + pocketBaseRateLimitRemainingMs(),
          })
          protectAfterCloudPressure('PocketHost rate limit reached.', await this.pendingCount())
          break
        }
        rememberPocketBaseRateLimit(error)
        failed += 1
        const attempts = (Number(sale.attempts) || 0) + 1
        await cashierDb.pendingSales.update(sale.clientSaleId, {
          attempts,
          // Completed client transactions are never abandoned automatically.
          // They remain durable and retryable until PocketHost confirms them.
          status: 'pending',
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
      if (rateLimited || isPocketBaseRateLimited()) { rateLimited = true; break }

      try {
        await this.uploadOperation(op)
        uploaded += 1
      } catch (error) {
        if (Number(error?.status) === 429) {
          rememberPocketBaseRateLimit(error)
          rateLimited = true
          await cashierDb.pendingOps.update(op.id, {
            lastError: pocketBaseRateLimitMessage(),
            nextAttemptAt: Date.now() + pocketBaseRateLimitRemainingMs(),
          })
          protectAfterCloudPressure('PocketHost rate limit reached.', await this.pendingCount())
          break
        }
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

    if (rateLimited && !warnings.length) warnings.push(pocketBaseRateLimitMessage())

    const pending = await this.pendingCount()
    this.dispatchEvent(new CustomEvent('synccomplete', {
      detail: { uploaded, failed, warnings },
    }))
    emitSyncStatus(
      peakProtectionStatus().active
        ? 'peak-protection'
        : catalogRefreshAuthFailed
        ? 'auth-required'
        : failed > 0 ? 'failed' : (rateLimited || pending > 0 || catalogRefreshFailed) ? 'waiting' : 'succeeded',
      peakProtectionStatus().active
        ? `Peak Protection Active — checkout is operating normally. ${pending} transaction(s) safely queued.`
        : catalogRefreshAuthFailed
        ? CLOUD_AUTH_REQUIRED_MESSAGE
        : failed > 0
          ? `Auto-Sync Finished with ${failed} Failed`
          : rateLimited
            ? `${pocketBaseRateLimitMessage()} ${pending} pending.`
            : catalogRefreshFailed
              ? `Product catalog could not refresh: ${warnings[warnings.length - 1]}`
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
      try {
        await this.pb.collection('activity_logs').create(activityPayload, { requestKey: op.id })
      } catch (error) {
        // Older terminals may retain a relation or timestamp shape that no
        // longer validates. Preserve the audit event using only required,
        // normalized fields so it cannot block the offline queue forever.
        if (error?.status !== 400) throw error
        await this.pb.collection('activity_logs').create(
          minimalActivityLogPayload(activityPayload),
          { requestKey: `${op.id}:minimal` },
        )
      }
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
          // Same fix as ensureCloudStockDeduction above: without lineId,
          // refunding/voiding two lines of the same product shares a single
          // (op.id, productId) movement reference, so restoring stock for
          // line 1 makes this lookup report "already restored" for line 2,
          // silently skipping it.
          const lineKey = item.lineId || productId
          const existingMovement = await this.pb.collection('stock_movements').getFirstListItem(
            this.pb.filter('reference_id = {:referenceId} && product_id = {:productId}', { referenceId: `${op.id}:${lineKey}`, productId }),
            { requestKey: null },
          ).catch(() => null)
          if (existingMovement) continue
          const returnedQuantity = quantizeQty(toBaseStockQuantity(Number(item.quantity) || 0, Number(item.conversion) || 1))
          if (returnedQuantity <= 0) continue
          const product = await this.pb.collection('products').getOne(productId, { requestKey: null })
          const previousQuantity = quantizeQty(product.quantity)
          const nextQuantity = quantizeQty(previousQuantity + returnedQuantity)
          await this.pb.collection('products').update(product.id, { quantity: numberFieldValue(nextQuantity) }, { requestKey: `${op.id}:${lineKey}:stock` })
          await this.pb.collection('stock_movements').create({
            product_id: product.id,
            movement_type: op.type === 'voidCompletedSale' ? 'void_return' : payload.type === 'exchange' ? 'exchange_return' : 'refund_return',
            quantity: returnedQuantity,
            previous_quantity: previousQuantity,
            new_quantity: nextQuantity,
            reference_type: op.type === 'voidCompletedSale' ? 'void' : payload.type,
            reference_id: `${op.id}:${lineKey}`,
            notes: `${op.type === 'voidCompletedSale' ? 'Void' : payload.type} ${payload.transactionNo}${payload.reason ? `: ${payload.reason}` : ''}`,
            user_id: payload.cashierId,
            created_at: payload.createdAt || new Date().toISOString(),
          }, { requestKey: `${op.id}:${lineKey}:movement` })
          await reconcileProductStock(this.pb, product.id)
      }
      if (op.type === 'adjustCompletedSale' && payload.adjustmentId) {
        // Durable cloud record of this refund/exchange (M1) — today, before
        // this, a refund only ever flipped sales.status; the amount, items,
        // reason, and approver existed only in this terminal's local Dexie
        // DB. adjustment_id is the idempotency anchor: a retried upload of
        // the same op must not create a second sale_adjustments record or
        // double-increment refunded_amount.
        const existingAdjustment = await this.pb.collection('sale_adjustments').getFirstListItem(
          this.pb.filter('adjustment_id = {:adjustmentId}', { adjustmentId: payload.adjustmentId }),
          { requestKey: null },
        ).catch(() => null)

        if (!existingAdjustment) {
          await this.pb.collection('sale_adjustments').create({
            sale_id: sale.id,
            adjustment_id: payload.adjustmentId,
            type: payload.type === 'exchange' ? 'exchange' : 'refund',
            amount: numberFieldValue(payload.amount),
            items: payload.items || [],
            reason: payload.reason || '',
            note: payload.note || '',
            approver_id: isPocketBaseRecordId(payload.approverId) ? payload.approverId : undefined,
            cashier_id: isPocketBaseRecordId(payload.cashierId) ? payload.cashierId : undefined,
            restock: payload.restock !== false,
            created_at: payload.createdAt || new Date().toISOString(),
          }, { requestKey: `${op.id}:adjustment` }).catch((error) => {
            // sale_adjustments may not exist yet on a PocketBase instance
            // that hasn't run scripts/add-refund-reporting-schema.mjs. Do
            // not fail the whole op over the reporting side-effect -- the
            // sale's own status update below (the part that already worked)
            // must still land.
            if (error?.status !== 404 && error?.status !== 400) throw error
          })

          const nextRefundedAmount = numberFieldValue(numberOrZero(sale.refunded_amount) + numberOrZero(payload.amount))
          const nextRefundedUnits = numberFieldValue(
            numberOrZero(sale.refunded_units)
            + (payload.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
          )
          await this.pb.collection('sales').update(sale.id, {
            refunded_amount: nextRefundedAmount,
            refunded_units: nextRefundedUnits,
            refunded_at: payload.createdAt || new Date().toISOString(),
          }, { requestKey: `${op.id}:refund-totals` }).catch((error) => {
            // Same as above: additive reporting fields may not exist yet on
            // an un-migrated PocketBase instance.
            if (error?.status !== 404 && error?.status !== 400) throw error
          })
        }
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

  // A void requested while this sale was still queued (or is in the middle
  // of uploading right now) tombstones the pendingSales row instead of
  // deleting it -- see the comment in voidLocalSale (saleRepository.js) for
  // why. `neverReachedCloud` means this tick never even attempted
  // sales.create for it, so there is nothing cloud-side to undo; otherwise
  // this exact upload just created the cloud sale (or it already existed
  // from an earlier attempt) and a void op must be queued to undo it.
  async finalizeVoidedSaleUpload(sale, { neverReachedCloud }) {
    if (!neverReachedCloud) {
      const opId = globalThis.crypto?.randomUUID?.() || `voidCompletedSale_${Date.now()}`
      await cashierDb.pendingOps.put({
        id: opId,
        type: 'voidCompletedSale',
        entityId: sale.clientSaleId,
        payload: {
          transactionNo: sale.transactionNo,
          cashierId: sale.cashierId,
          approverId: '',
          reason: sale.voidReason || '',
          items: sale.items || [],
          createdAt: sale.voidedAt || new Date().toISOString(),
        },
        status: 'pending',
        attempts: 0,
        lastError: '',
        nextAttemptAt: 0,
        createdAt: Date.now(),
      })
    }
    await cashierDb.pendingSales.delete(sale.clientSaleId)
    if (cashierDb.tables.some((table) => table.name === 'completedSales')) {
      await cashierDb.completedSales.update(sale.clientSaleId, { syncStatus: 'voided' })
    }
  }

  async uploadSale(sale) {
    if (sale.voidPending) {
      // Voided before this tick ever attempted to upload it -- nothing
      // reached the cloud, so there is nothing to undo there.
      await this.finalizeVoidedSaleUpload(sale, { neverReachedCloud: true })
      return
    }

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

    // Re-read the queue row fresh right before the final write, rather than
    // trusting the in-memory `sale` captured when this upload started: a
    // void issued while this exact upload was in flight tombstones the row
    // (see voidLocalSale) but this call has no other way to learn about it.
    // Without this check, the sale above just got created in the cloud as
    // "completed" with stock deducted, and finishing normally here would
    // mark it synced with no void ever reaching the cloud -- permanently
    // double-counting stock (restored locally, still deducted in the cloud).
    const currentPending = await cashierDb.pendingSales.get(sale.clientSaleId)
    if (currentPending?.voidPending) {
      await this.finalizeVoidedSaleUpload(
        { ...sale, voidReason: currentPending.voidReason, voidedAt: currentPending.voidedAt },
        { neverReachedCloud: false },
      )
      return
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
