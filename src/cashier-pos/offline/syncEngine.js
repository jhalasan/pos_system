import Dexie from 'dexie'
import PocketBase from 'pocketbase'
import { cashierDb } from './db'

const DEFAULT_INTERVAL_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function retryDelay(attempts) {
  const exponential = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempts, 8)))
  return exponential + Math.floor(Math.random() * 500)
}

function cloudSalePayload(sale) {
  return {
    client_sale_id: sale.clientSaleId,
    transaction_no: sale.transactionNo,
    cashier_id: sale.cashierId,
    total_amount: sale.totalAmount,
    payment_method: sale.paymentMethod,
    ref_number: sale.refNumber,
    status: 'completed',
    created_at: sale.createdAt,
    items: sale.items,
    subtotal_amount: sale.subtotalAmount,
    discount_percent: sale.discountPercent,
    discount_amount: sale.discountAmount,
  }
}

function saleActivityDetail(sale) {
  const itemCount = sale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  return `Completed transaction ${sale.transactionNo} with ${itemCount} item(s), total PHP ${Number(sale.totalAmount || 0).toFixed(2)}.`
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
    if (!(await this.isCloudReachable())) {
      this.dispatchEvent(new CustomEvent('offline'))
      return { uploaded: 0, failed: 0 }
    }

    const now = Date.now()
    const queuedSales = await cashierDb.pendingSales
      .where('[status+nextAttemptAt]')
      .between(['pending', Dexie.minKey], ['pending', now])
      .sortBy('createdAt')

    let uploaded = 0
    let failed = 0

    for (const sale of queuedSales) {
      if (this.stopped) break

      try {
        await this.uploadSale(sale)
        uploaded += 1
      } catch (error) {
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
    return { uploaded, failed }
  }

  async uploadSale(sale) {
    try {
      await this.pb.collection('sales').create(cloudSalePayload(sale), {
        requestKey: `sale:${sale.clientSaleId}`,
      })
    } catch (error) {
      if (error?.status !== 400 && error?.status !== 409) throw error

      const existing = await this.pb.collection('sales').getFirstListItem(
        this.pb.filter('client_sale_id = {:clientSaleId}', {
          clientSaleId: sale.clientSaleId,
        }),
        { requestKey: null },
      ).catch(() => null)

      if (!existing) throw error
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

    await cashierDb.pendingSales.delete(sale.clientSaleId)
    await cashierDb.completedSales.update(sale.clientSaleId, { syncStatus: 'synced' })
    this.dispatchEvent(new CustomEvent('salesynced', {
      detail: { clientSaleId: sale.clientSaleId },
    }))
  }
}
