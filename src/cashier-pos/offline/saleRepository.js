import { cashierDb, initializeCashierDb } from './db.js'
import { adminDb, initializeAdminDb } from '../../admin-page/offline/db.js'
import { barcodesMatch } from '../utils/barcodeUtils.js'
import { normalizeProduct, safeBulkPutProducts } from './productRepository.js'
import { toBaseStockQuantity } from './stockUtils.js'
import { getTerminalId, getTerminalName } from '../../utils/terminalIdentity.js'
import { discountedUnitPrice, quantizeQty } from '../../utils/quantity.js'
import { mintTransactionNumber } from './transactionNumber.js'

async function hasTable(name) {
  await initializeCashierDb()
  return cashierDb.tables.some((table) => table.name === name)
}

async function loadProductFromAdminCache({ productId, barcode }) {
  await initializeAdminDb()
  if (productId) {
    const cached = await adminDb.products.get(String(productId))
    if (cached) return normalizeProduct(cached)
  }

  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return null

  const cached = await adminDb.products
    .filter((candidate) => (
      barcodesMatch(candidate.barcode, normalizedBarcode)
      || (Array.isArray(candidate.sellingUnits) && candidate.sellingUnits.some((unit) => barcodesMatch(unit?.barcode, normalizedBarcode)))
    ))
    .first()
  return cached ? normalizeProduct(cached) : null
}

function newClientSaleId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('This runtime does not support secure UUID generation.')
  }
  return globalThis.crypto.randomUUID()
}

function validateSale(sale) {
  if (!sale.cashierId) throw new Error('Cashier is required.')
  if (!Array.isArray(sale.items) || sale.items.length === 0) {
    throw new Error('Sale must contain at least one item.')
  }
  if (!(Number(sale.totalAmount) > 0)) {
    throw new Error('Sale total must be greater than zero.')
  }
}

export async function finalizeSaleLocally(sale) {
  validateSale(sale)
  await initializeCashierDb()

  const clientSaleId = newClientSaleId()
  const createdAt = new Date().toISOString()

  const pendingSale = {
    clientSaleId,
    terminalId: getTerminalId(),
    terminalName: getTerminalName(),
    cashierId: sale.cashierId,
    cashierName: String(sale.cashierName || ''),
    customerName: String(sale.customerName || '').trim().slice(0, 120),
    // Minted fresh below, inside the transaction — never the caller-supplied
    // `sale.transactionNo` (a UI preview, or the old racy generator). See
    // transactionNumber.js: the number that actually gets recorded must be
    // claimed atomically against this terminal's own counter, which only
    // this transaction can guarantee.
    transactionNo: '',
    totalAmount: Number(sale.totalAmount),
    subtotalAmount: Number(sale.subtotalAmount) || Number(sale.totalAmount),
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod: sale.paymentMethod === 'gcash' ? 'gcash' : 'cash',
    cashAmount: Number(sale.cashAmount) || 0,
    gcashAmount: Number(sale.gcashAmount) || 0,
    splitPayments: sale.splitPayments || null,
    refNumber: String(sale.refNumber || ''),
    items: sale.items.map((item) => ({
      productId: String(item.productId || item.id || ''),
      name: String(item.name || ''),
      barcode: String(item.barcode || ''),
      quantity: quantizeQty(item.quantity),
      conversion: Number(item.conversion) > 0 ? Number(item.conversion) : 1,
      price: Number(item.price) || 0,
      category: String(item.category || ''),
    })),
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt,
  }

  const canStoreCompletedSales = await hasTable('completedSales')
  const transactionTables = [
    cashierDb.products,
    cashierDb.pendingSales,
    cashierDb.settings,
  ]
  if (canStoreCompletedSales) transactionTables.push(cashierDb.completedSales)
  // Pre-resolve any missing products from the admin cache before starting
  // the cashier DB transaction. This avoids awaiting other DBs while a
  // Dexie transaction is active which can cause "transaction has finished"
  // InvalidStateError when object stores are accessed after the transaction
  // lifetime.
  const recoveredProducts = []
  for (const item of pendingSale.items) {
    if (!item.productId || item.quantity <= 0) {
      throw new Error(`Invalid line item: ${item.name || item.productId || 'unknown product'}.`)
    }

    const local = await cashierDb.products.get(item.productId)
    if (!local) {
      const fetched = await loadProductFromAdminCache({ productId: item.productId, barcode: item.barcode })
      if (fetched) recoveredProducts.push(fetched)
    }
  }

  await cashierDb.transaction(
    'rw',
    ...transactionTables,
    async () => {
      if (recoveredProducts.length) {
        // A recovered product's row must never be able to abort the sale
        // transaction — worst case, skip the write for that row and let the
        // "not available locally" check below surface a clear error instead
        // of losing the whole sale to an unrelated constraint.
        await safeBulkPutProducts(cashierDb.products, recoveredProducts)
      }

      for (const item of pendingSale.items) {
        const product = await cashierDb.products.get(item.productId)
        if (!product) throw new Error(`Product "${item.name || item.productId}" is not available locally.`)

        const baseQuantity = quantizeQty(toBaseStockQuantity(item.quantity, item.conversion))
        if (product.quantity < baseQuantity) {
          throw new Error(`"${product.name}" has only ${product.quantity} item(s) left.`)
        }

        await cashierDb.products.update(product.id, {
          quantity: quantizeQty(product.quantity - baseQuantity),
        })
      }

      pendingSale.transactionNo = await mintTransactionNumber(new Date(createdAt))

      await cashierDb.pendingSales.add(pendingSale)
      if (canStoreCompletedSales) {
        await cashierDb.completedSales.put({
          ...pendingSale,
          status: 'completed',
          syncStatus: 'pending',
        })
      }
    },
  )

  return pendingSale
}

export async function getPendingSales() {
  await initializeCashierDb()
  return cashierDb.pendingSales.orderBy('createdAt').toArray()
}

export async function getCompletedSales() {
  if (!(await hasTable('completedSales'))) return []
  return cashierDb.completedSales.orderBy('createdAt').reverse().toArray()
}

export async function getPendingSaleCount() {
  await initializeCashierDb()
  return cashierDb.pendingSales.count()
}

export async function retryFailedSale(clientSaleId) {
  await initializeCashierDb()
  const updated = await cashierDb.pendingSales.update(clientSaleId, {
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
  })

  if (!updated) throw new Error(`Queued sale "${clientSaleId}" was not found.`)
}

async function restoreProductStock(items = []) {
  for (const item of items) {
    const productId = String(item.productId || item.id || '')
    if (!productId) continue
    const product = await cashierDb.products.get(productId)
    if (!product) continue
    await cashierDb.products.update(product.id, {
      quantity: quantizeQty((Number(product.quantity) || 0) + toBaseStockQuantity(item.quantity, item.conversion)),
    })
  }
}

export async function findLocalSale(clientSaleId) {
  await initializeCashierDb()
  const pendingSale = await cashierDb.pendingSales.get(clientSaleId)
  const completedSale = await hasTable('completedSales')
    ? await cashierDb.completedSales.get(clientSaleId)
    : null

  return completedSale || pendingSale || null
}

export async function findLocalSaleByTransactionNo(transactionNo) {
  await initializeCashierDb()
  const value = String(transactionNo || '').trim()
  if (!value) return null

  if (await hasTable('completedSales')) {
    const completedSale = await cashierDb.completedSales.get({ transactionNo: value })
    if (completedSale) return completedSale
  }

  return cashierDb.pendingSales
    .filter((sale) => String(sale.transactionNo || '') === value)
    .first()
}

export async function voidLocalSale(clientSaleId, metadata = {}) {
  await initializeCashierDb()
  const sale = await findLocalSale(clientSaleId)
  if (!sale) throw new Error(`Completed sale "${clientSaleId}" was not found locally.`)
  if (sale.status === 'voided') throw new Error('This transaction has already been voided.')

  const canStoreCompletedSales = await hasTable('completedSales')
  const transactionTables = [cashierDb.products, cashierDb.pendingSales]
  if (canStoreCompletedSales) transactionTables.push(cashierDb.completedSales)

  await cashierDb.transaction('rw', ...transactionTables, async () => {
    await restoreProductStock(sale.items)

    // If this sale is still sitting in the upload queue, an upload attempt
    // may already be in flight for it right now (uploadSale in
    // syncEngine.js holds its own in-memory copy, read before this
    // transaction started). A bare delete here would let that in-flight
    // upload finish unaware anything happened: it would create the sale in
    // the cloud as a normal completed sale, with no way to know a void was
    // just requested -- leaving the cloud copy "completed" and cloud stock
    // deducted forever, while local stock has already been restored above.
    // Tombstoning instead of deleting lets uploadSale re-check this flag
    // right before its final write and react instead of finishing blind.
    const stillQueued = await cashierDb.pendingSales.get(clientSaleId)
    if (stillQueued) {
      await cashierDb.pendingSales.update(clientSaleId, {
        voidPending: true,
        voidReason: metadata.reason || '',
        voidedBy: metadata.voidedBy || '',
        voidedAt: metadata.voidedAt || new Date().toISOString(),
      })
    } else {
      await cashierDb.pendingSales.delete(clientSaleId)
    }

    if (canStoreCompletedSales) {
      await cashierDb.completedSales.put({
        ...sale,
        status: 'voided',
        syncStatus: 'voided',
        voidedAt: metadata.voidedAt || new Date().toISOString(),
        voidedBy: metadata.voidedBy || '',
        voidReason: metadata.reason || '',
      })
    }
  })

  return {
    ...sale,
    status: 'voided',
    syncStatus: 'voided',
    voidedAt: metadata.voidedAt || new Date().toISOString(),
    voidedBy: metadata.voidedBy || '',
    voidReason: metadata.reason || '',
  }
}

export async function adjustLocalSale(clientSaleId, adjustment = {}) {
  await initializeCashierDb()
  const sale = await findLocalSale(clientSaleId)
  if (!sale) throw new Error(`Completed sale "${clientSaleId}" was not found locally.`)
  if (sale.status === 'voided') throw new Error('This transaction has already been voided.')

  const type = adjustment.type === 'exchange' ? 'exchange' : 'refund'
  const selectedItems = Array.isArray(adjustment.items) ? adjustment.items : []
  const selectedByProduct = new Map(selectedItems.map((item) => [
    String(item.productId || item.id || ''),
    Math.max(0, quantizeQty(item.quantity)),
  ]))

  const returnedItems = sale.items
    .map((item) => {
      const productId = String(item.productId || item.id || '')
      const requestedQty = selectedByProduct.get(productId) || 0
      const alreadyAdjusted = quantizeQty((sale.adjustments || [])
        .flatMap((entry) => entry.items || [])
        .filter((entry) => String(entry.productId || entry.id || '') === productId)
        .reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0))
      const availableQty = Math.max(0, quantizeQty((Number(item.quantity) || 0) - alreadyAdjusted))
      const quantity = Math.min(availableQty, requestedQty)

      return quantity > 0
        ? {
            productId,
            name: String(item.name || ''),
            barcode: String(item.barcode || ''),
            quantity,
            // The stored line price is pre-discount; the sale's discount was
            // applied once across the whole cart, so it must be re-applied
            // here or a discounted sale gets refunded at full price.
            price: discountedUnitPrice(item.price, sale.discountPercent),
            // Carried through from the *stored* sale line, never from
            // caller-supplied UI input: a refund restock must convert using
            // the same unit the sale was originally rung up in, or a
            // multi-unit product (e.g. a case of 24) restocks 1 base unit
            // instead of 24.
            conversion: Number(item.conversion) > 0 ? Number(item.conversion) : 1,
          }
        : null
    })
    .filter(Boolean)

  if (returnedItems.length === 0) {
    throw new Error('Select at least one refundable item quantity.')
  }

  const amount = returnedItems.reduce((sum, item) => sum + (item.quantity * item.price), 0)
  const entry = {
    id: globalThis.crypto?.randomUUID?.() || `${type}_${Date.now()}`,
    type,
    reason: String(adjustment.reason || '').trim(),
    approvedBy: String(adjustment.approvedBy || ''),
    cashierId: String(adjustment.cashierId || ''),
    createdAt: adjustment.createdAt || new Date().toISOString(),
    amount,
    items: returnedItems,
    note: String(adjustment.note || '').trim(),
    restock: adjustment.restock !== false,
  }

  // The cloud op is queued from this SAME clamped, conversion-carrying
  // `entry` — never from raw caller input — and in the same Dexie
  // transaction as the local stock/adjustment write. Queuing raw UI items
  // separately (the old behavior, in desktopApi.js) meant a refund of 99
  // units on a 2-unit line restocked 2 locally but 99 in the cloud, and a
  // crash between two independent writes could lose either side.
  const cloudOpId = globalThis.crypto?.randomUUID?.() || `adjustCompletedSale_${Date.now()}`
  const cloudOp = {
    id: cloudOpId,
    type: 'adjustCompletedSale',
    entityId: clientSaleId,
    payload: {
      transactionNo: sale.transactionNo,
      cashierId: entry.cashierId || sale.cashierId,
      approverId: String(adjustment.approverId || ''),
      type: entry.type,
      items: entry.items,
      reason: entry.reason,
      note: entry.note,
      restock: entry.restock,
      createdAt: entry.createdAt,
      // The idempotency anchor for the durable sale_adjustments cloud
      // record (M1) — the same id this local adjustment entry already
      // carries, so a retried upload looks itself up by this value instead
      // of creating a duplicate refund record or double-counting
      // refunded_amount.
      adjustmentId: entry.id,
      amount: entry.amount,
    },
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }

  const canStoreCompletedSales = await hasTable('completedSales')
  const transactionTables = [cashierDb.products, cashierDb.pendingOps]
  if (canStoreCompletedSales) transactionTables.push(cashierDb.completedSales)

  await cashierDb.transaction('rw', ...transactionTables, async () => {
    if (entry.restock) await restoreProductStock(returnedItems)

    await cashierDb.pendingOps.put(cloudOp)

    if (canStoreCompletedSales) {
      await cashierDb.completedSales.put({
        ...sale,
        status: 'adjusted',
        adjustments: [...(sale.adjustments || []), entry],
        adjustedAt: entry.createdAt,
      })
    }
  })

  return {
    ...sale,
    status: 'adjusted',
    adjustments: [...(sale.adjustments || []), entry],
    adjustedAt: entry.createdAt,
  }
}
