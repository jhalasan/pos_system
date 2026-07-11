import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsCashierBarcodeLogin } from '../src/cashier-pos/utils/cashierLoginPolicy.js';

test('allows cashier barcode login for barcodes that start with 92', () => {
  assert.equal(allowsCashierBarcodeLogin('9234567890'), true);
  assert.equal(allowsCashierBarcodeLogin(''), false);
});
