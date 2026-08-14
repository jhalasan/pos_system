import assert from 'node:assert/strict'
import test from 'node:test'
import { stockQuantityFromMovements } from '../src/utils/stockMovementReconciler.js'

test('simultaneous terminal sales that both branch off the same previous_quantity are declined, not blindly summed', () => {
  // Both terminals sold offline against the same last-known quantity (20)
  // before either sync reached the server, so the second movement's
  // previous_quantity does not chain onto the first movement's new_quantity.
  // Blindly summing deltas here (the old behavior) silently produced a
  // plausible-looking but wrong total (15) instead of surfacing the
  // conflict — chain validation now declines to guess (null) instead.
  const movements = [
    { movement_type: 'sale', quantity: 2, previous_quantity: 20, new_quantity: 18 },
    { movement_type: 'sale', quantity: 3, previous_quantity: 20, new_quantity: 17 },
  ]
  assert.equal(stockQuantityFromMovements(movements), null)
})

test('offline sale followed by void restores the base quantity once', () => {
  const movements = [
    { movement_type: 'sale', quantity: 5, previous_quantity: 20, new_quantity: 15 },
    { movement_type: 'void_return', quantity: 5, previous_quantity: 15, new_quantity: 20 },
  ]
  assert.equal(stockQuantityFromMovements(movements), 20)
})

test('mixed stock operations from two terminals with a genuine ordering gap are declined, not blindly summed', () => {
  // The second movement also branches off the original baseline (50) rather
  // than chaining onto the first movement's result (60) — another
  // concurrent-write conflict. Chain validation declines to guess (null)
  // instead of silently summing every delta regardless of order (the old
  // behavior, which produced 54 here without ever checking the movements
  // were contiguous).
  const movements = [
    { movement_type: 'stock_in', quantity: 10, previous_quantity: 50, new_quantity: 60 },
    { movement_type: 'sale', quantity: 4, previous_quantity: 50, new_quantity: 46 },
    { movement_type: 'refund_return', quantity: 1, previous_quantity: 46, new_quantity: 47 },
    { movement_type: 'stock_out', quantity: 3, previous_quantity: 47, new_quantity: 44 },
  ]
  assert.equal(stockQuantityFromMovements(movements), null)
})
