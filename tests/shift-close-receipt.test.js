import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShiftCloseReceiptText } from '../src/cashier-pos/services/receiptPrinter.js';

test('buildShiftCloseReceiptText includes denomination breakdown and totals', () => {
  const receipt = buildShiftCloseReceiptText({
    cashierName: 'Cashier One',
    openedAt: '2026-07-08T09:00:00.000Z',
    closedAt: '2026-07-08T17:30:00.000Z',
    openingAmount: 1000,
    cashSales: 2500,
    cashIn: 200,
    cashOut: 100,
    expectedCash: 3600,
    actualCash: 3700,
    variance: 100,
    countMode: 'denomination',
    denominations: [
      { denomination: 1000, count: 2 },
      { denomination: 500, count: 1 },
      { denomination: 100, count: 3 },
    ],
  });

  assert.match(receipt, /SHIFT CLOSE REPORT/);
  assert.match(receipt, /1000/);
  assert.match(receipt, /500/);
  assert.match(receipt, /Actual Cash Ending/);
  assert.match(receipt, /Variance/);
});
