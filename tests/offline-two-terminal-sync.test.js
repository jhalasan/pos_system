import assert from 'node:assert/strict'
import test from 'node:test'
import { stockQuantityFromMovements } from '../src/utils/stockMovementReconciler.js'

test('simultaneous terminal sales converge from the movement ledger', () => {
  const movements = [
    { movement_type: 'sale', quantity: 2, previous_quantity: 20, new_quantity: 18 },
    { movement_type: 'sale', quantity: 3, previous_quantity: 20, new_quantity: 17 },
  ]
  assert.equal(stockQuantityFromMovements(movements), 15)
})

test('offline sale followed by void restores the base quantity once', () => {
  const movements = [
    { movement_type: 'sale', quantity: 5, previous_quantity: 20, new_quantity: 15 },
    { movement_type: 'void_return', quantity: 5, previous_quantity: 15, new_quantity: 20 },
  ]
  assert.equal(stockQuantityFromMovements(movements), 20)
})

test('mixed stock operations from two terminals retain every delta', () => {
  const movements = [
    { movement_type: 'stock_in', quantity: 10, previous_quantity: 50, new_quantity: 60 },
    { movement_type: 'sale', quantity: 4, previous_quantity: 50, new_quantity: 46 },
    { movement_type: 'refund_return', quantity: 1, previous_quantity: 46, new_quantity: 47 },
    { movement_type: 'stock_out', quantity: 3, previous_quantity: 47, new_quantity: 44 },
  ]
  assert.equal(stockQuantityFromMovements(movements), 54)
})
