import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantizeQty,
  floorQty,
  toMillis,
  fromMillis,
  roundMoney,
  formatQty,
  pluralizeUnit,
  isFractional,
} from '../src/utils/quantity.js';

test('quantizeQty rounds to three decimals', () => {
  assert.equal(quantizeQty(1.23456), 1.235);
  assert.equal(quantizeQty('0.5'), 0.5);
  assert.equal(quantizeQty(null), 0);
});

test('floorQty truncates to three decimals without rounding up', () => {
  assert.equal(floorQty(2.9999), 2.999);
  assert.equal(floorQty(0.0001), 0);
});

test('toMillis/fromMillis round-trip exactly, avoiding float drift', () => {
  assert.equal(toMillis(0.1) + toMillis(0.2), toMillis(0.3));
  assert.equal(fromMillis(toMillis(1.75)), 1.75);
});

test('roundMoney rounds to centavos', () => {
  assert.equal(roundMoney(19.995), 20);
  assert.equal(roundMoney(1.004), 1);
});

test('formatQty trims trailing zeros', () => {
  assert.equal(formatQty(2), '2');
  assert.equal(formatQty(0.5), '0.5');
  assert.equal(formatQty(1.75), '1.75');
});

test('pluralizeUnit is singular only at exactly one', () => {
  assert.equal(pluralizeUnit('Case', 1), 'Case');
  assert.equal(pluralizeUnit('Case', 0.5), 'Cases');
  assert.equal(pluralizeUnit('Case', 2), 'Cases');
  assert.equal(pluralizeUnit('Box', 1), 'Box');
  assert.equal(pluralizeUnit('Box', 2, { box: 'Boxes' }), 'Boxes');
});

test('pluralizeUnit leaves an already-plural label untouched', () => {
  assert.equal(pluralizeUnit('Bottles', 2), 'Bottles');
});

test('isFractional reads either camelCase or snake_case flag', () => {
  assert.equal(isFractional({ allowFractional: true }), true);
  assert.equal(isFractional({ allow_fractional: true }), true);
  assert.equal(isFractional({}), false);
});
