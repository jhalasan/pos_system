import test from 'node:test';
import assert from 'node:assert/strict';
import { toBaseStockQuantity } from '../src/cashier-pos/offline/stockUtils.js';

test('converts a selling-unit sale into base-stock quantity', () => {
  assert.equal(toBaseStockQuantity(1, 12), 12);
  assert.equal(toBaseStockQuantity(2, 4), 8);
});

test('defaults to one base unit when conversion is missing', () => {
  assert.equal(toBaseStockQuantity(3), 3);
  assert.equal(toBaseStockQuantity(0, 12), 0);
});
