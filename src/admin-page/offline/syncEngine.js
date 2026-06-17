import Dexie from 'dexie'
import PocketBase from 'pocketbase'
import { adminDb } from './db'
import { normalizeProduct } from './productRepository'
import { refreshAdminLocalCache } from './cloudBootstrap'

const DEFAULT_INTERVAL_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10

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
  const payload = {
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: data.categoryId || await getOrCreateCategoryId(pb, data.category),
    quantity: Number(data.qty) || 0,
    base_unit: data.unit || 'Piece',
    min_stock: Number(data.lowStock) || 0,
    price: Number(data.price) || 0,
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
    this.timer = setTimeout(() => void this.syncNow(), delay)
  }

  async isCloudReachable() {
    if (globalThis.navigator && !globalThis.navigator.onLine) return false

    try {
      await this.pb.health.check({ requestKey: null })
      return true
    } catch {
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
      .where('[status+nextAttemptAt]')
      .between(['pending', Dexie.minKey], ['pending', now])
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

    for (const op of queuedOps) {
      if (this.stopped) break

      try {
        await this.uploadOperation(op)
        uploaded += 1
      } catch (error) {
        failed += 1
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
        failed += 1
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { log, error } }))
      }
    }

    if (uploaded > 0) {
      await refreshAdminLocalCache({ pb: this.pb }).catch((error) => {
        this.dispatchEvent(new CustomEvent('syncerror', { detail: { error } }))
      })
    }

    this.dispatchEvent(new CustomEvent('synccomplete', { detail: { uploaded, failed } }))
    emitSyncStatus(
      failed > 0 ? 'failed' : 'succeeded',
      failed > 0
        ? `Auto-Sync Finished with ${failed} Failed`
        : 'Auto-Sync Succeeded',
    )
    return { uploaded, failed }
  }

  async uploadOperation(op) {
    if (op.type === 'createProduct') {
      const created = await this.pb.collection('products').create(await productBody(this.pb, op.payload), {
        expand: 'category',
        requestKey: op.id,
      })
      const normalized = normalizeProduct(created, this.pb)
      await adminDb.transaction('rw', adminDb.products, adminDb.pendingOps, async () => {
        await adminDb.products.delete(op.productId)
        await adminDb.products.put(normalized)

        const laterOps = await adminDb.pendingOps.where('productId').equals(op.productId).toArray()
        for (const laterOp of laterOps) {
          await adminDb.pendingOps.update(laterOp.id, {
            productId: created.id,
            payload: {
              ...laterOp.payload,
              id: created.id,
              categoryId: normalized.categoryId || laterOp.payload?.categoryId,
            },
          })
        }

        await adminDb.pendingOps.delete(op.id)
      })
      return
    }

    if (op.type === 'updateProduct') {
      const updated = await this.pb.collection('products').update(op.productId, await productBody(this.pb, op.payload), {
        expand: 'category',
        requestKey: op.id,
      })
      await adminDb.products.put(normalizeProduct(updated, this.pb))
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'deleteProduct') {
      await this.pb.collection('products').delete(op.productId, { requestKey: op.id }).catch((error) => {
        if (error.status !== 404) throw error
      })
      await adminDb.products.delete(op.productId)
      await adminDb.pendingOps.delete(op.id)
      return
    }

    if (op.type === 'scanInventory') {
      const product = await this.pb.collection('products').getOne(op.productId, { requestKey: null })
      const updated = await this.pb.collection('products').update(op.productId, {
        quantity: (Number(product.quantity) || 0) + Number(op.payload.qty || 0),
      }, {
        expand: 'category',
        requestKey: op.id,
      })
      await adminDb.products.put(normalizeProduct(updated, this.pb))
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
