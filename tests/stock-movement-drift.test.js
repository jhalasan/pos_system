import test from 'node:test';
import assert from 'node:assert/strict';
import { stockQuantityFromMovements } from '../src/utils/stockMovementReconciler.js';

// Regression guard: naive floating-point summation of fractional stock
// movements does not land on exact values (0.1 + 0.2 !== 0.3 in JS), which
// would make reconcileProductStock's strict equality check write a
// "correction" on every single run. Movements are summed in integer
// thousandths internally to avoid this.
test('fractional stock-ins sum to an exact value, not a drifted float', () => {
  const movements = [
    { movement_type: 'stock_in', quantity: 0.1, previous_quantity: 0, new_quantity: 0.1 },
    { movement_type: 'stock_in', quantity: 0.2, previous_quantity: 0.1, new_quantity: 0.3 },
  ];
  assert.equal(stockQuantityFromMovements(movements), 0.3);
});

test('a fractional sale followed by a void restores the exact starting quantity', () => {
  const movements = [
    { movement_type: 'sale', quantity: 1.75, previous_quantity: 50, new_quantity: 48.25 },
    { movement_type: 'void_return', quantity: 1.75, previous_quantity: 48.25, new_quantity: 50 },
  ];
  assert.equal(stockQuantityFromMovements(movements), 50);
});

test('many small fractional movements do not accumulate drift', () => {
  let qty = 10;
  const movements = [];
  for (let i = 0; i < 10; i += 1) {
    const next = Math.round((qty - 0.1) * 1000) / 1000;
    movements.push({ movement_type: 'stock_out', quantity: 0.1, previous_quantity: qty, new_quantity: next });
    qty = next;
  }
  assert.equal(stockQuantityFromMovements(movements), 9);
});
