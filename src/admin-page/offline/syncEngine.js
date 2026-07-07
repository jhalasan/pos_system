import PocketBase from 'pocketbase'
import { adminDb } from './db'
import { deriveStatus, normalizeProduct } from './productRepository'
import { refreshAdminLocalCache } from './cloudBootstrap'
import {
  isPocketBaseRateLimited,
  pocketBaseRateLimitRemainingMs,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'

const DEFAULT_INTERVAL_MS = 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, number) : 0)
}

function emitSyncStatus(state, message) {
  globalThis.dispatchEvent?.(new CustomEvent('nexa-sync-status', {
    detail: {
      scope: 'admin',
      state,
      message,
    },
  }))
}

function errorMessage(error) {
  const fieldErrors = error?.response?.data || error?.data?.data || {}
  const details = Object.entries(fieldErrors)
    .map(([field, value]) => {
      const message = value?.message || value?.code || String(value || '')
      return message ? `${field}: ${message}` : ''
    })
    .filter(Boolean)

  if (details.length) return details.join(' ')
  if (error?.response?.message || error?.data?.message) {
    return error.response?.message || error.data?.message
  }
  return error instanceof Error ? error.message : String(error)
}

function retryDelay(attempts) {
  const exponential = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempts, 8)))
  return exponential + Math.floor(Math.random() * 500)
}

async function getOrCreateCategoryId(pb, name) {
  const categoryName = String(name || '').trim()
  if (!categoryName) return ''

  const existing = await pb.collection('categories').getFirstListItem(
    pb.filter('name = {:name}', { name: categoryName }),
    { requestKey: null },
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (existing) return existing.id
  const created = await pb.collection('categories').create({ name: categoryName }, { requestKey: null })
  await adminDb.categories.put({ id: created.id, name: created.name, updated: created.updated })
  return created.id
}

async function productBody(pb, data) {
  const qty = Number(data.qty)
  const lowStock = Number(data.lowStock)
  const price = Number(data.price)
  const payload = {
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: data.categoryId || await getOrCreateCategoryId(pb, data.category),
    quantity: numberFieldValue(qty),
    base_unit: data.unit || 'Piece',
    min_stock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
  }

  const imageBlob = data.imageBlob || data.imageFile
  if (!imageBlob) return payload

  const formData = new FormData()
  for (const [key, value] of Object.entries(payload)) {
    formData.append(key, value ?? '')
  }
  formData.append('product_img', imageBlob, data.imageName || imageBlob.name || 'product-image.webp')
  return formData
}

async function findCloudProductByBarcode(pb, barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return null

  return pb.collection('products').getFirstListItem(
    pb.filter('barcode = {:barcode}', { barcode: normalizedBarcode }),
    { expand: 'category', requestKey: null },
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })
}

async function resolveCloudProductForLocalProduct(pb, productId, payload = {}) {
  const product = await pb.collection('products').getOne(productId, {
    expand: 'category',
    requestKey: null,
  }).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (product) return product

  const localProduct = await adminDb.products.get(productId).catch(() => null)
  const barcode = payload.barcode || localProduct?.barcode
  return findCloudProductByBarcode(pb, barcode)
}

async function createCloudProductFromLocal(pb, productId, payload = {}, requestKey = null) {
  const localProduct = await adminDb.products.get(productId).catch(() => null)
  const source = localProduct || payload
  if (!source?.name || !source?.barcode) return null

  return pb.collection('products').create(await productBody(pb, source), {
    expand: 'category',
    requestKey,
  }).catch(async (error) => {
    if (error.status !== 400 && error.status !== 409) throw error
    return findCloudProductByBarcode(pb, source.barcode)
  })
}

function stockDeltaForOp(op) {
  const qty = Math.max(0, Number(op?.payload?.qty) || 0)
  if (op?.type === 'scanInventory') return qty
  if (op?.type === 'stockOutInventory') return -qty
  return 0
}

async function createStockMovement(pb, product, op, previousQuantity, nextQuantity) {
  const delta = Number(nextQuantity) - Number(previousQuantity)
  if (!product?.id || delta === 0) return

  const movementType = delta > 0 ? 'stock_in' : 'stock_out'
  await pb.collection('stock_movements').create({
    product_id: product.id,
    movement_type: movementType,
    quantity: Math.abs(delta),
    previous_quantity: Number(previousQuantity) || 0,
    new_quantity: Number(nextQuantity) || 0,
    reference_type: op.type,
    reference_id: op.id,
    notes: op.payload?.note || op.payload?.reason || '',
    created_at: new Date().toISOString(),
  }, {
    requestKey: `stock-movement:${op.id}`,
  }).catch(() => null)
}

async function replaceLocalProductWithCloud(localProductId, cloudRecord, pb, options = {}) {
  const normalized = normalizeProduct(cloudRecord, pb)

  await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
    const localProduct = await adminDb.products.get(localProductId)
    const laterOps = await adminDb.pendingOps.where('productId').equals(localProductId).toArray()
    const remainingOps = laterOps.filter((laterOp) => laterOp.id !== options.currentOpId)
    const remainingStockDelta = remainingOps.reduce((sum, laterOp) => sum + stockDeltaForOp(laterOp), 0)
    const hasLaterStockOps = remainingOps.some((laterOp) => stockDeltaForOp(laterOp) !== 0)
    const replayedQty = Math.max(0, (Number(normalized.qty) || 0) + remainingStockDelta)
    const nextProduct = options.preservePendingStock && hasLaterStockOps && localProduct
      ? {
          ...normalized,
          qty: replayedQty,
          pendingSync: true,
          status: deriveStatus({ ...normalized, qty: replayedQty }),
        }
      : normalized

    await adminDb.products.delete(localProductId)
    await adminDb.products.put(nextProduct)

    for (const laterOp of laterOps) {
      await adminDb.pendingOps.update(laterOp.id, {
        productId: cloudRecord.id,
        payload: {
          ...laterOp.payload,
          id: cloudRecord.id,
          categoryId: normalized.categoryId || laterOp.payload?.categoryId,
        },
      })
    }
  })

  return normalized
}

export class AdminSyncEngine extends EventTarget {
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

  async syncNow() {
    if (this.syncPromise) return this.syncPromise

    this.syncPromise = this.runSync()
      .finally(() => {
        this.syncPromise = null
        this.schedule()
      })

    return this.syncPromise
  }

  async runSync() {
    const now = Date.now()
    const queuedOps = await adminDb.pendingOps
      .where('status')
      .equals('pending')
      .filter((op) => (Number(op.nextAttemptAt) || 0) <= now)
      .sortBy('createdAt')
    const queuedLogs = await adminDb.activityLogs
      .filter((log) => !log.cloudId)
      .toArray()

    if (queuedOps.length === 0 && queuedLogs.length === 0) {
      return { uploaded: 0, failed: 0 }
    }

    if (!(await this.isCloudReachable())) {
      emitSyncStatus('offline', 'Auto-Sync Waiting for Connection')
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0 }
    }

    emitSyncStatus('running', 'Auto-Sync Running')

    let uploaded = 0
    let failed = 0
    const errors = []

    for (const op of queuedOps) {
      if (this.stopped) break

      try {
        await this.uploadOperation(op)
        uploaded += 1
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        failed += 1
        errors.push(errorMessage(error))
        const attempts = op.attempts + 1
        await adminDb.pendingOps.update(op.id, {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: errorMessage(error),
          nextAttemptAt: Date.now() + retryDelay(attempts),
        })
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { op, error } }))
      }
    }

    for (const log of queuedLogs) {
      if (this.stopped) break

      try {
        await this.uploadActivityLog(log)
        uploaded += 1
      } catch (error) {
        rememberPocketBaseRateLimit(error)
        failed += 1
        errors.push(errorMessage(error))
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { log, error } }))
      }
    }

    if (uploaded > 0) {
      await refreshAdminLocalCache({ pb: this.pb }).catch((error) => {
        rememberPocketBaseRateLimit(error)
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { error } }))
      })
    }

    this.dispatchEvent(new CustomEvent('synccomplete', { detail: { uploaded, failed, errors } }))
    emitSyncStatus(
      failed > 0 ? 'failed' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed: ${errors[0] || 'Unknown error'}`
        : 'Auto-Sync Succeeded',
    )
    return { uploaded, failed, errors }
  }

  async uploadOperation(op) {
    if (op.type === 'createProduct') {
      const existing = await findCloudProductByBarcode(this.pb, op.payload?.barcode)
      const saved = existing
        ? await this.pb.collection('products').update(existing.id, await productBody(this.pb, op.payload), {
            expand: 'category',
            requestKey: op.id,
          })
        : await this.pb.collection('products').create(await productBody(this.pb, op.payload), {
            expand: 'category',
            requestKey: op.id,
          })

      await replaceLocalProductWithCloud(op.productId, saved, this.pb)
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        await adminDb.pendingOps.delete(op.id)
      })
      return
    }

    if (op.type === 'updateProduct') {
      const target = await resolveCloudProductForLocalProduct(this.pb, op.productId, op.payload)
        || await createCloudProductFromLocal(this.pb, op.productId, op.payload, `${op.id}:create-missing`)
      if (!target) throw new Error(`Product "${op.payload?.name || op.payload?.barcode || op.productId}" was not found in PocketBase.`)

      const updated = await this.pb.collection('products').update(target.id, await productBody(this.pb, op.payload), {
        expand: 'category',
        requestKey: op.id,
      })
      await replaceLocalProductWithCloud(op.productId, updated, this.pb)
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'deleteProduct') {
      try {
        await this.pb.collection('products').delete(op.productId, { requestKey: op.id })
      } catch (error) {
        const message = error?.message || ''
        const isRelationConstraint = /required relation|relation reference|foreign key|dependent/i.test(message)
        if (error?.status !== 404 && !isRelationConstraint) throw error
      }

      const existing = await adminDb.products.get(op.productId).catch(() => null)
      if (existing) {
        await adminDb.products.put({
          ...existing,
          deleted: true,
          pendingSync: false,
          updated: new Date().toISOString(),
        })
      } else {
        await adminDb.products.delete(op.productId).catch(() => {})
      }
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'scanInventory') {
      const product = await resolveCloudProductForLocalProduct(this.pb, op.productId, op.payload)
      if (!product) {
        const created = await createCloudProductFromLocal(this.pb, op.productId, op.payload, `${op.id}:create-missing`)
        if (!created) throw new Error(`Product "${op.payload?.barcode || op.productId}" was not found in PocketBase.`)
        await replaceLocalProductWithCloud(op.productId, created, this.pb, {
          preservePendingStock: true,
          currentOpId: op.id,
        })
        await adminDb.pendingOps.delete(op.id)
        return
      }

      const previousQuantity = Number(product.quantity) || 0
      const nextQuantity = previousQuantity + Number(op.payload.qty || 0)
      const updated = await this.pb.collection('products').update(product.id, {
        quantity: numberFieldValue(nextQuantity),
      }, {
        expand: 'category',
        requestKey: op.id,
      })
      await createStockMovement(this.pb, updated, op, previousQuantity, nextQuantity)
      await replaceLocalProductWithCloud(op.productId, updated, this.pb, {
        preservePendingStock: true,
        currentOpId: op.id,
      })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'stockOutInventory') {
      const product = await resolveCloudProductForLocalProduct(this.pb, op.productId, op.payload)
      if (!product) throw new Error(`Product "${op.payload?.barcode || op.productId}" was not found in PocketBase.`)

      const previousQuantity = Number(product.quantity) || 0
      const nextQuantity = Math.max(0, previousQuantity - Number(op.payload.qty || 0))
      const updated = await this.pb.collection('products').update(product.id, {
        quantity: numberFieldValue(nextQuantity),
      }, {
        expand: 'category',
        requestKey: op.id,
      })
      await createStockMovement(this.pb, updated, op, previousQuantity, nextQuantity)
      await replaceLocalProductWithCloud(op.productId, updated, this.pb, {
        preservePendingStock: true,
        currentOpId: op.id,
      })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    throw new Error(`Unknown admin sync operation: ${op.type}`)
  }

  async uploadActivityLog(log) {
    const record = await this.pb.collection('activity_logs').create({
      user_id: log.userId || '',
      action_type: log.action || 'Activity',
      description: log.detail || '',
      timestamp: log.time || new Date().toISOString(),
    }, { requestKey: log.id })

    await adminDb.activityLogs.update(log.id, { cloudId: record.id })
  }
}
