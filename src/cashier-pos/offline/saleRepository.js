import { cashierDb } from './db'

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

  const clientSaleId = newClientSaleId()
  const createdAt = new Date().toISOString()

  const pendingSale = {
    clientSaleId,
    cashierId: sale.cashierId,
    transactionNo: sale.transactionNo || `OFFLINE-${clientSaleId.slice(0, 8).toUpperCase()}`,
    totalAmount: Number(sale.totalAmount),
    subtotalAmount: Number(sale.subtotalAmount) || Number(sale.totalAmount),
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod: sale.paymentMethod === 'gcash' ? 'gcash' : 'cash',
    refNumber: String(sale.refNumber || ''),
    items: sale.items.map((item) => ({
      productId: String(item.productId || item.id || ''),
      name: String(item.name || ''),
      barcode: String(item.barcode || ''),
      quantity: Number(item.quantity) || 0,
      price: Number(item.price) || 0,
    })),
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
    createdAt,
  }

  await cashierDb.transaction(
    'rw',
    cashierDb.products,
    cashierDb.pendingSales,
    async () => {
      for (const item of pendingSale.items) {
        if (!item.productId || item.quantity <= 0) {
          throw new Error(`Invalid line item: ${item.name || item.productId || 'unknown product'}.`)
        }

        const product = await cashierDb.products.get(item.productId)
        if (!product) throw new Error(`Product "${item.name || item.productId}" is not available locally.`)
        if (product.quantity < item.quantity) {
          throw new Error(`"${product.name}" has only ${product.quantity} item(s) left.`)
        }

        await cashierDb.products.update(product.id, {
          quantity: product.quantity - item.quantity,
        })
      }

      await cashierDb.pendingSales.add(pendingSale)
    },
  )

  return pendingSale
}

export function getPendingSales() {
  return cashierDb.pendingSales.orderBy('createdAt').toArray()
}

export function getPendingSaleCount() {
  return cashierDb.pendingSales.count()
}

export async function retryFailedSale(clientSaleId) {
  const updated = await cashierDb.pendingSales.update(clientSaleId, {
    status: 'pending',
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
  })

  if (!updated) throw new Error(`Queued sale "${clientSaleId}" was not found.`)
}
