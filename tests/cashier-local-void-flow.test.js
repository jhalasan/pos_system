import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'

// Terminal identity (used when a sale is recorded) reads localStorage, which
// Node doesn't have; back it with a plain Map like the other cashier tests do.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import {
  finalizeSaleLocally,
  findLocalSale,
  findLocalSaleByTransactionNo,
  getShiftLedgerTotals,
  voidLocalSale,
} from '../src/cashier-pos/offline/saleRepository.js'

// The terminal-side half of "Receipt Lookup -> Void": find a completed sale by
// its transaction number, void it, and confirm what the client expects -- the
// items go back to inventory, the sale comes off the shift's sales/cash, and it
// stays findable as Voided so it shows in history. Uses the real repository
// code against a fake IndexedDB.

const CASHIER = 'cashier-1'
const SHIFT_START = '2000-01-01T00:00:00.000Z'

async function freshDb() {
  await cashierDb.delete()
  await initializeCashierDb()
  await cashierDb.products.bulkPut([
    { id: 'coke', name: 'Coke 1.5L', barcode: '4800001', quantity: 10, price: 85 },
    { id: 'case-beer', name: 'Beer (case of 24 bottles)', barcode: '4800002', quantity: 100, price: 40 },
  ])
}

async function sell(items, total) {
  return finalizeSaleLocally({
    cashierId: CASHIER, cashierName: 'ARLIE VELASCO', customerName: 'Juan Dela Cruz',
    totalAmount: total, subtotalAmount: total, paymentMethod: 'cash', cashAmount: total, items,
  })
}
const stockOf = async (id) => Number((await cashierDb.products.get(id)).quantity)

test('a completed sale can be found by transaction number, and voiding it returns stock and removes it from shift sales', { concurrency: false }, async () => {
  await freshDb()
  const queued = await sell([{ productId: 'coke', name: 'Coke 1.5L', barcode: '4800001', quantity: 3, conversion: 1, price: 85 }], 255)
  assert.equal(await stockOf('coke'), 7, 'the sale deducted 3')

  // 1. Receipt Lookup: find it by the number printed on the receipt
  const found = await findLocalSaleByTransactionNo(queued.transactionNo)
  assert.ok(found, 'the receipt must be found by its transaction number')
  assert.equal(found.clientSaleId, queued.clientSaleId)
  assert.equal(found.customerName, 'Juan Dela Cruz')
  assert.equal((await getShiftLedgerTotals(CASHIER, SHIFT_START)).cashSales, 255, 'counted as cash sales before the void')

  // 2. Confirm Void
  await voidLocalSale(found.clientSaleId, { reason: 'wrong item', voidedBy: 'Manager One', voidedAt: new Date().toISOString() })

  assert.equal(await stockOf('coke'), 10, 'the 3 items are back in inventory')
  assert.equal((await getShiftLedgerTotals(CASHIER, SHIFT_START)).cashSales, 0, 'it comes off the shift cash sales (and so off the Z-read)')

  // 3. History: still findable by number, now shown as voided with who/why
  const after = await findLocalSaleByTransactionNo(queued.transactionNo)
  assert.equal(after.status, 'voided')
  assert.equal(after.voidReason, 'wrong item')
  assert.equal(after.voidedBy, 'Manager One')
  assert.equal((await findLocalSale(found.clientSaleId)).status, 'voided')

  await cashierDb.delete()
})

test('voiding a multi-unit sale returns the BASE units (a case of 24 puts 24 back, not 1)', { concurrency: false }, async () => {
  await freshDb()
  const queued = await sell([{ productId: 'case-beer', name: 'Beer case', barcode: '4800002', quantity: 2, conversion: 24, price: 960 }], 1920)
  assert.equal(await stockOf('case-beer'), 100 - 48, '2 cases = 48 bottles out')

  await voidLocalSale(queued.clientSaleId, { reason: 'customer changed mind', voidedBy: 'Manager One' })

  assert.equal(await stockOf('case-beer'), 100, 'all 48 bottles are back')
  await cashierDb.delete()
})

test('a sale cannot be voided twice (stock is not restored a second time)', { concurrency: false }, async () => {
  await freshDb()
  const queued = await sell([{ productId: 'coke', name: 'Coke 1.5L', barcode: '4800001', quantity: 2, conversion: 1, price: 85 }], 170)
  await voidLocalSale(queued.clientSaleId, { reason: 'x', voidedBy: 'M' })
  assert.equal(await stockOf('coke'), 10)

  await assert.rejects(() => voidLocalSale(queued.clientSaleId, { reason: 'again', voidedBy: 'M' }), /already been voided/i)
  assert.equal(await stockOf('coke'), 10, 'still 10, not 12')
  await cashierDb.delete()
})

test('looking up a number that does not exist on this terminal finds nothing locally (the cloud fallback is separate)', { concurrency: false }, async () => {
  await freshDb()
  assert.ok(!(await findLocalSaleByTransactionNo('99999999999')), 'nothing found locally')
  await cashierDb.delete()
})
