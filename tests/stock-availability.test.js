import test from 'node:test';
import assert from 'node:assert/strict';
import { toBaseStockQuantity, getAvailableStockUnits } from '../src/cashier-pos/offline/stockUtils.js';

test('converts a selling-unit sale into base-stock quantity', () => {
  assert.equal(toBaseStockQuantity(1, 12), 12);
  assert.equal(toBaseStockQuantity(2, 4), 8);
});

test('computes how many selling units remain from base stock', () => {
  assert.equal(getAvailableStockUnits({ qty: 24 }, { conversion: 12 }), 2);
  assert.equal(getAvailableStockUnits({ quantity: 6 }, { conversion: 3 }), 2);
});

test('returns zero when available stock is exhausted', () => {
  assert.equal(getAvailableStockUnits({ qty: 0 }, { conversion: 12 }), 0);
  assert.equal(getAvailableStockUnits({ quantity: 3 }, { conversion: 4 }), 0);
});
