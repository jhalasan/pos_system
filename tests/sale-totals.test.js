import assert from 'node:assert/strict'
import test from 'node:test'
import { netSaleAmount, netSaleUnits } from '../src/utils/saleTotals.js'

// M1: a legacy sale row created before refunded_amount/refunded_units
// existed must report its full original total/units, completely unchanged
// -- not zero, not an error. A missing field must behave exactly like zero
// refunded.

test('a legacy sale with no refunded fields at all reports its full total unchanged', () => {
  const sale = { totalAmount: 500, items: [{ quantity: 3 }] }
  assert.equal(netSaleAmount(sale), 500)
  assert.equal(netSaleUnits(sale), 3)
})

test('a fully-refunded sale nets to zero, not negative', () => {
  const sale = { totalAmount: 200, refundedAmount: 200, items: [{ quantity: 2 }], refundedUnits: 2 }
  assert.equal(netSaleAmount(sale), 0)
  assert.equal(netSaleUnits(sale), 0)
})

test('a partial refund nets out only the refunded portion', () => {
  const sale = { totalAmount: 500, refundedAmount: 120, items: [{ quantity: 5 }], refundedUnits: 1 }
  assert.equal(netSaleAmount(sale), 380)
  assert.equal(netSaleUnits(sale), 4)
})

test('an over-refunded record (should never happen, but must not go negative) clamps to zero', () => {
  const sale = { totalAmount: 100, refundedAmount: 999, items: [{ quantity: 1 }], refundedUnits: 999 }
  assert.equal(netSaleAmount(sale), 0)
  assert.equal(netSaleUnits(sale), 0)
})

test('accepts raw PocketBase snake_case field names as well as camelCase', () => {
  const sale = { total_amount: 300, refunded_amount: 50, items: [{ quantity_sold: 4 }], refunded_units: 1 }
  assert.equal(netSaleAmount(sale), 250)
  assert.equal(netSaleUnits(sale), 3)
})

test('a sale with no items array reports zero units, not a crash', () => {
  const sale = { totalAmount: 100 }
  assert.equal(netSaleUnits(sale), 0)
})
