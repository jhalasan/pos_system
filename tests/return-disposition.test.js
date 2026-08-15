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
