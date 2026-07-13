import PocketBase from 'pocketbase'
import { adminDb } from './db'
import { deriveStatus, normalizeProduct } from './productRepository'
import { refreshAdminLocalCache } from './cloudBootstrap'
import {
  isPocketBaseRateLimited,
  pocketBaseRateLimitRemainingMs,
  rememberPocketBaseRateLimit,
} from '../../utils/pocketbaseRateLimit'
import { findStockMovement, reconcileProductStock } from '../../utils/stockMovementReconciler'

const DEFAULT_INTERVAL_MS = 60_000
const CLOUD_PULL_INTERVAL_MS = 2 * 60_000
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

function queuedStaffBody(payload = {}) {
  const { profileImage, profileImageName, ...fields } = payload
  if (!profileImage) return fields
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) formData.append(key, value ?? '')
  formData.append('profile_img', profileImage, profileImageName || profileImage.name || 'staff-profile.webp')
  return formData
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
  const cost = Number(data.cost)
  const profitMargin = Number(data.profitMargin)
  const initialStock = Number(data.initialStock ?? data.initial_stock)
  const conversionQuantity = Number(data.conversionQuantity ?? data.conversion_quantity ?? 1)
  const payload = {
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: data.categoryId || await getOrCreateCategoryId(pb, data.category),
    quantity: numberFieldValue(qty),
    base_unit: data.unit || 'Piece',
    purchase_unit: String(data.purchaseUnit || data.purchase_unit || '').trim(),
    conversion_quantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    initial_stock: Number.isFinite(initialStock) ? Math.max(0, initialStock) : 0,
    stock_unit: String(data.stockUnit || data.stock_unit || '').trim(),
    min_stock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
    cost: Number.isFinite(cost) ? Math.max(0, cost) : 0,
    profitMargin: Number.isFinite(profitMargin) ? Math.max(0, profitMargin) : 0,
    has_multiple_units: Boolean(data.hasMultipleUnits ?? data.has_multiple_units),
  }
  // include selling units when present so desktop/admin sync preserves additional units
  if (Array.isArray(data.sellingUnits) && data.sellingUnits.length > 0) {
    payload.selling_units = data.sellingUnits
  } else if (Array.isArray(data.selling_units) && data.selling_units.length > 0) {
    payload.selling_units = data.selling_units
  }

  const imageBlob = data.imageBlob || data.imageFile
  if (!imageBlob) return payload

  const formData = new FormData()
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'selling_units') {
      formData.append(key, JSON.stringify(value || []))
    } else {
      formData.append(key, value ?? '')
    }
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
  if (await findStockMovement(pb, product.id, op.id)) return
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
  })
  await reconcileProductStock(pb, product.id)
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
    this.lastCloudPullAt = 0
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
    const shouldPullCloud = now - this.lastCloudPullAt >= CLOUD_PULL_INTERVAL_MS

    if (queuedOps.length === 0 && queuedLogs.length === 0 && !shouldPullCloud) {
      return { uploaded: 0, failed: 0, pending: await adminDb.pendingOps.count() }
    }

    if (!(await this.isCloudReachable())) {
      emitSyncStatus('offline', `Offline — ${queuedOps.length} change(s) waiting to sync`)
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0, pending: await adminDb.pendingOps.count() }
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
        if (error?.syncConflict) {
          await adminDb.pendingOps.update(op.id, {
            status: 'conflict',
            lastError: 'Newer cloud product data requires review.',
            conflict: error.syncConflict,
            nextAttemptAt: 0,
          })
          continue
        }
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

    let pulled = false
    if (uploaded > 0 || shouldPullCloud) {
      pulled = await refreshAdminLocalCache({ pb: this.pb }).then(() => true).catch((error) => {
        rememberPocketBaseRateLimit(error)
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { error } }))
        return false
      })
      if (pulled) this.lastCloudPullAt = Date.now()
    }

    this.dispatchEvent(new CustomEvent('synccomplete', { detail: { uploaded, failed, errors } }))
    emitSyncStatus(
      failed > 0 ? 'failed' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed: ${errors[0] || 'Unknown error'}`
        : `Auto-Sync Succeeded — ${await adminDb.pendingOps.count()} pending`,
    )
    return { uploaded, failed, errors, pulled, pending: await adminDb.pendingOps.count() }
  }

  async uploadOperation(op) {
    if (op.type === 'createCategory') {
      const existing = await this.pb.collection('categories').getFirstListItem(
        this.pb.filter('name = {:name}', { name: op.payload.name }),
        { requestKey: null },
      ).catch((error) => error?.status === 404 ? null : Promise.reject(error))
      const saved = existing || await this.pb.collection('categories').create({ name: op.payload.name }, { requestKey: op.id })
      await adminDb.transaction('rw', adminDb.categories, adminDb.pendingOps, async () => {
        await adminDb.categories.delete(op.productId)
        await adminDb.categories.put({ id: saved.id, name: saved.name, updated: saved.updated })
        await adminDb.pendingOps.delete(op.id)
      })
      return
    }

    if (op.type === 'updateUserSettings') {
      const saved = await this.pb.collection('users').update(op.productId, op.payload, { requestKey: op.id })
      await adminDb.users.update(op.productId, { ...op.payload, updated: saved.updated })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'markAuditReviewed') {
      await this.pb.collection('audit_reviews').create(op.payload, { requestKey: op.id })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'createStaff') {
      const saved = await this.pb.collection('users').create(queuedStaffBody(op.payload), { requestKey: op.id })
      await adminDb.transaction('rw', adminDb.users, adminDb.pendingOps, async () => {
        await adminDb.users.delete(op.productId)
        await adminDb.users.put({
          id: saved.id,
          email: saved.email,
          name: saved.name || saved.email,
          role: saved.role,
          shift: saved.shift || '',
          status: saved.status || 'active',
          cashierBarcode: saved.void_barcode || '',
          void_barcode: saved.void_barcode || '',
          pendingSync: false,
          updated: saved.updated,
        })
        const laterOps = await adminDb.pendingOps.where('productId').equals(op.productId).toArray()
        for (const laterOp of laterOps) await adminDb.pendingOps.update(laterOp.id, { productId: saved.id })
        await adminDb.pendingOps.delete(op.id)
      })
      return
    }

    if (op.type === 'updateStaff') {
      await this.pb.collection('users').update(op.productId, queuedStaffBody(op.payload), { requestKey: op.id })
      await adminDb.users.update(op.productId, { pendingSync: false })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'deleteStaff') {
      await this.pb.collection('users').delete(op.productId, { requestKey: op.id }).catch((error) => {
        if (error?.status !== 404) throw error
      })
      await adminDb.users.delete(op.productId)
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'createAuthorizationBarcode') {
      const saved = await this.pb.collection('authorization_barcodes').create({
        code: op.payload.barcode,
        label: op.payload.label,
        purpose: 'void_discount',
        status: op.payload.status || 'active',
        generated_by: op.payload.generatedById,
      }, { expand: 'generated_by', requestKey: op.id })
      const generatedBy = Array.isArray(saved.expand?.generated_by) ? saved.expand.generated_by[0] : saved.expand?.generated_by
      await adminDb.transaction('rw', adminDb.authorizationBarcodes, adminDb.pendingOps, async () => {
        await adminDb.authorizationBarcodes.delete(op.productId)
        await adminDb.authorizationBarcodes.put({
          id: saved.id,
          barcode: saved.code,
          label: saved.label,
          status: saved.status,
          generatedBy: generatedBy?.name || generatedBy?.email || op.payload.generatedBy,
          generatedById: generatedBy?.id || op.payload.generatedById,
          generatedByEmail: generatedBy?.email || op.payload.generatedByEmail,
          createdAt: saved.created,
          pendingSync: false,
        })
        const laterOps = await adminDb.pendingOps.where('productId').equals(op.productId).toArray()
        for (const laterOp of laterOps) await adminDb.pendingOps.update(laterOp.id, { productId: saved.id })
        await adminDb.pendingOps.delete(op.id)
      })
      return
    }

    if (op.type === 'updateAuthorizationBarcode') {
      await this.pb.collection('authorization_barcodes').update(op.productId, op.payload, { requestKey: op.id })
      await adminDb.authorizationBarcodes.update(op.productId, { ...op.payload, pendingSync: false })
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'deleteAuthorizationBarcode') {
      await this.pb.collection('authorization_barcodes').delete(op.productId, { requestKey: op.id }).catch((error) => {
        if (error?.status !== 404) throw error
      })
      await adminDb.authorizationBarcodes.delete(op.productId)
      await adminDb.pendingOps.delete(op.id)
      return
    }

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

      const cloudProduct = normalizeProduct(target, this.pb)
      const conflictFields = ['name', 'barcode', 'categoryId', 'unit', 'purchaseUnit', 'conversionQuantity', 'lowStock', 'price', 'cost', 'sellingUnits']
        .filter((field) => JSON.stringify(op.payload?.[field] ?? null) !== JSON.stringify(cloudProduct?.[field] ?? null))
      if (!op.payload?.forceConflictResolution && conflictFields.length > 0 && new Date(target.updated).getTime() > new Date(op.createdAt).getTime()) {
        const conflictError = new Error('Newer cloud product data requires review.')
        conflictError.syncConflict = {
          type: 'product',
          fields: conflictFields,
          local: op.payload,
          cloud: cloudProduct,
          cloudUpdated: target.updated,
          localUpdated: op.createdAt,
        }
        throw conflictError
      }

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
