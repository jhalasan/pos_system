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
