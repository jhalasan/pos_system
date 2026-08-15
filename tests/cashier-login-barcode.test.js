import test from 'node:test';
import assert from 'node:assert/strict';
import { isBarcodeProvided } from '../src/cashier-pos/utils/cashierLoginPolicy.js';

// Renamed from allowsCashierBarcodeLogin -- that name implied a real policy
// gate (format validation, an allow-list) that never existed; this only
// ever checked for a non-empty value. The old test name ("allows cashier
// barcode login for barcodes that start with 92") was also misleading: it
// asserted nothing specific to a "92" prefix -- any non-empty string passes.
// The server (POST /api/cashier/auth/barcode) is the actual authority.
test('any non-empty barcode value passes the pre-check', () => {
  assert.equal(isBarcodeProvided('9234567890'), true);
  assert.equal(isBarcodeProvided('not-a-real-format-either'), true);
});

test('an empty or whitespace-only value does not', () => {
  assert.equal(isBarcodeProvided(''), false);
  assert.equal(isBarcodeProvided('   '), false);
});
