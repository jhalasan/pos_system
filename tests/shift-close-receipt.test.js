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
    gcashSales: 850,
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

  // This test was never wired into any npm script (see POS_AUDIT_REGISTER.md
  // H2) and had drifted from receiptPrinter.js's actual labels -- "Z-READ
  // REPORT" and "Counted Cash" are the real, current POS terminology used
  // there; this assertion was checking for label text the code never
  // produced.
  assert.match(receipt, /Z-READ REPORT/);
  assert.match(receipt, /1000/);
  assert.match(receipt, /500/);
  assert.match(receipt, /Counted Cash/);
  assert.match(receipt, /Variance/);
  assert.match(receipt, /GCash Sales/);
  assert.match(receipt, /850/);
});
