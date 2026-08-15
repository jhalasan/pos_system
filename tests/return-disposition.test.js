import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { adjustLocalSale } from '../src/cashier-pos/offline/saleRepository.js'

async function seedReturnScenario(id) {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Test Product', qty: 5, quantity: 5, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: id,
    cashierId: 'cashier-1',
    transactionNo: id,
    status: 'completed',
    createdAt: new Date().toISOString(),
    items: [{ productId: 'product-1', name: 'Test Product', barcode: '1001', quantity: 2, price: 10 }],
    adjustments: [],
  })
}

test('refund can record damaged goods without returning them to stock', { concurrency: false }, async () => {
  await seedReturnScenario('NO-RESTOCK')
  const adjusted = await adjustLocalSale('NO-RESTOCK', { type: 'refund', items: [{ productId: 'product-1', quantity: 1 }], reason: 'Damaged', restock: false })
  assert.equal((await cashierDb.products.get('product-1')).quantity, 5)
  assert.equal(adjusted.adjustments.at(-1).restock, false)
  await cashierDb.delete()
})

test('refund returns sellable goods to available stock', { concurrency: false }, async () => {
  await seedReturnScenario('RESTOCK')
  const adjusted = await adjustLocalSale('RESTOCK', { type: 'refund', items: [{ productId: 'product-1', quantity: 1 }], reason: 'Wrong item', restock: true })
  assert.equal((await cashierDb.products.get('product-1')).quantity, 6)
  assert.equal(adjusted.adjustments.at(-1).restock, true)
  await cashierDb.delete()
})

// A sale's discount is applied once across the whole cart; line items only
// ever carry their pre-discount unit price. Refunding at that raw price
// overpays the customer relative to what they actually paid for the item.
test('refund of a discounted sale is prorated by the sale discount, not the raw line price', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Test Product', qty: 5, quantity: 5, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: 'DISCOUNTED',
    cashierId: 'cashier-1',
    transactionNo: 'DISCOUNTED',
    status: 'completed',
    createdAt: new Date().toISOString(),
    discountPercent: 10,
    items: [{ productId: 'product-1', name: 'Test Product', barcode: '1001', quantity: 2, price: 10 }],
    adjustments: [],
  })

  const adjusted = await adjustLocalSale('DISCOUNTED', { type: 'refund', items: [{ productId: 'product-1', quantity: 1 }], reason: 'Wrong item' })
  const lastAdjustment = adjusted.adjustments.at(-1)
  assert.equal(lastAdjustment.items[0].price, 9, 'refunded unit price must reflect the 10% sale discount')
  assert.equal(lastAdjustment.amount, 9)
  await cashierDb.delete()
})

// M2: a refund used to drop `conversion` when rebuilding the returned items,
// so a case-of-24 sale restocked 1 base unit instead of 24 (toBaseStockQuantity
// falls back to conversion=1 when it's undefined).
test('refunding a multi-unit sale restocks in base units using the sale line\'s own conversion', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Case of Soda', qty: 0, quantity: 0, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: 'CASE-SALE',
    cashierId: 'cashier-1',
    transactionNo: 'CASE-SALE',
    status: 'completed',
    createdAt: new Date().toISOString(),
    items: [{ productId: 'product-1', name: 'Case of Soda', barcode: '1001', quantity: 1, price: 240, conversion: 24 }],
    adjustments: [],
  })

  await adjustLocalSale('CASE-SALE', { type: 'refund', items: [{ productId: 'product-1', quantity: 1 }], reason: 'Unopened return', restock: true })
  assert.equal((await cashierDb.products.get('product-1')).quantity, 24, 'refunding 1 case (conversion 24) must restock 24 base units, not 1')
  await cashierDb.delete()
})

// M3: the cloud op used to be queued separately from raw UI input, before
// adjustLocalSale's clamp ran, and in a separate Dexie transaction. Now
// adjustLocalSale queues it itself, atomically, using the same clamped
// entry -- so it must never be able to ask for more than what's left to
// refund, and it must carry the same conversion as the local restock.
test('adjustLocalSale queues a cloud op atomically, clamped to what is actually left to refund', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Case of Soda', qty: 0, quantity: 0, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: 'OVER-REFUND',
    cashierId: 'cashier-1',
    transactionNo: 'OVER-REFUND',
    status: 'completed',
    createdAt: new Date().toISOString(),
    items: [{ productId: 'product-1', name: 'Case of Soda', barcode: '1001', quantity: 2, price: 240, conversion: 24 }],
    adjustments: [],
  })

  // Ask for 99 when only 2 were sold -- must clamp to 2, both locally and
  // in the queued cloud op.
  await adjustLocalSale('OVER-REFUND', {
    type: 'refund',
    items: [{ productId: 'product-1', quantity: 99 }],
    reason: 'Overclaim attempt',
    restock: true,
    approverId: 'approver-id-000',
  })

  const queuedOps = await cashierDb.pendingOps.where('type').equals('adjustCompletedSale').toArray()
  assert.equal(queuedOps.length, 1, 'exactly one cloud op must be queued, in the same transaction as the local write')
  const queuedItem = queuedOps[0].payload.items[0]
  assert.equal(queuedItem.quantity, 2, 'the queued cloud op must be clamped to what was actually sold, not the raw 99 requested')
  assert.equal(queuedItem.conversion, 24, 'the queued cloud op must carry the same conversion as the local restock')
  assert.equal(queuedOps[0].payload.approverId, 'approver-id-000')
  await cashierDb.delete()
})

// T3, continued: two cart lines of the same product (one sold as a case,
// one sold loose) used to collapse into a single productId-keyed entry when
// selecting how much to refund from each -- a requested quantity on one
// line silently applied to *every* line of that product in the sale.
// lineId gives each line its own identity here too, not just in the cloud
// stock-movement bookkeeping T3 originally fixed.
test('refunding one line of a product does not affect a separate line of the same product', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Sample Product', qty: 0, quantity: 0, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: 'DUAL-LINE',
    cashierId: 'cashier-1',
    transactionNo: 'DUAL-LINE',
    status: 'completed',
    createdAt: new Date().toISOString(),
    items: [
      { lineId: 'line-case', productId: 'product-1', name: 'Sample Product', barcode: '1001', quantity: 1, price: 150, conversion: 10 },
      { lineId: 'line-piece', productId: 'product-1', name: 'Sample Product', barcode: '1001', quantity: 3, price: 15, conversion: 1 },
    ],
    adjustments: [],
  })

  // Refund all 3 loose pieces; the case line is untouched.
  const adjusted = await adjustLocalSale('DUAL-LINE', {
    type: 'refund',
    items: [{ productId: 'product-1', lineId: 'line-piece', quantity: 3 }],
    reason: 'Customer changed mind',
    restock: true,
  })

  const returnedItems = adjusted.adjustments.at(-1).items
  assert.equal(returnedItems.length, 1, 'only the requested line should be refunded, not both lines of the same product')
  assert.equal(returnedItems[0].lineId, 'line-piece')
  assert.equal(returnedItems[0].quantity, 3)
  // 3 loose pieces (conversion 1) restocked, the case (conversion 10) left
  // alone -- a productId-only match would have restocked the case too (or
  // instead), converting at the wrong ratio.
  assert.equal((await cashierDb.products.get('product-1')).quantity, 3)
  await cashierDb.delete()
})

test('refunding the case line does not consume the loose-piece line\'s available balance', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.put({ id: 'product-1', barcode: '1001', name: 'Sample Product', qty: 0, quantity: 0, unit: 'Piece' })
  await cashierDb.completedSales.put({
    clientSaleId: 'DUAL-LINE-2',
    cashierId: 'cashier-1',
    transactionNo: 'DUAL-LINE-2',
    status: 'completed',
    createdAt: new Date().toISOString(),
    items: [
      { lineId: 'line-case', productId: 'product-1', name: 'Sample Product', barcode: '1001', quantity: 1, price: 150, conversion: 10 },
      { lineId: 'line-piece', productId: 'product-1', name: 'Sample Product', barcode: '1001', quantity: 3, price: 15, conversion: 1 },
    ],
    adjustments: [],
  })

  await adjustLocalSale('DUAL-LINE-2', {
    type: 'refund',
    items: [{ productId: 'product-1', lineId: 'line-case', quantity: 1 }],
    reason: 'Case was damaged',
    restock: true,
  })

  // The loose-piece line must still show its full, untouched quantity as
  // refundable -- a productId-only "already adjusted" lookup would have
  // wrongly counted the case's 1 unit against the piece line's balance too.
  const secondRefund = await adjustLocalSale('DUAL-LINE-2', {
    type: 'refund',
    items: [{ productId: 'product-1', lineId: 'line-piece', quantity: 3 }],
    reason: 'Customer changed mind',
    restock: true,
  })
  const latestItems = secondRefund.adjustments.at(-1).items
  assert.equal(latestItems[0].quantity, 3, 'the full 3 loose pieces must still be refundable after only the case line was refunded')
  await cashierDb.delete()
})
