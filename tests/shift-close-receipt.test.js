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

// Client-reported: GCash Sales was printed as a single easy-to-miss line at
// the very bottom, below the whole cash-count block -- a cashier reading
// only Cash Sales/Expected Cash could walk away thinking that was the
// shift's total revenue and never notice GCash sales happened at all.
// Gross Sale (Cash Sales + GCash Sales) is now printed prominently near the
// top, before the cash-count breakdown, so total revenue is never missed.
test('buildShiftCloseReceiptText prints Gross Sale (cash + gcash) prominently, before the cash-count block', () => {
  const receipt = buildShiftCloseReceiptText({
    cashierName: 'Cashier One',
    openedAt: '2026-07-08T09:00:00.000Z',
    closedAt: '2026-07-08T17:30:00.000Z',
    openingAmount: 0,
    cashSales: 38193.58,
    gcashSales: 2749.5,
    cashIn: 0,
    cashOut: 0,
    expectedCash: 38193.58,
    actualCash: 42415,
    variance: 4221.42,
    countMode: 'denomination',
    denominations: [],
  });

  assert.match(receipt, /Gross Sale/);
  assert.match(receipt, /40,943\.08/); // 38,193.58 + 2,749.50, printed with the same thousands-separator formatting as other money lines

  const grossSaleIndex = receipt.indexOf('Gross Sale');
  const openingCashIndex = receipt.indexOf('Opening Cash');
  const expectedCashIndex = receipt.indexOf('Expected Cash');
  assert.ok(grossSaleIndex >= 0 && openingCashIndex >= 0 && expectedCashIndex >= 0);
  assert.ok(grossSaleIndex < openingCashIndex, 'Gross Sale must print before the cash-count block starts');
  assert.ok(grossSaleIndex < expectedCashIndex, 'Gross Sale must print before Expected Cash');
});

test('buildShiftCloseReceiptText Gross Sale is exactly cash + gcash, unaffected by cash in/out (which only affect the drawer-cash block)', () => {
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
    countMode: 'manual',
    denominations: [],
  });

  assert.match(receipt, /Gross Sale\s+3,350\.00/); // 2500 + 850, not touched by the 200 cash-in/100 cash-out
});
