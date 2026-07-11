import test from 'node:test';
import assert from 'node:assert/strict';
import { getCashSalesAmount, getCashSalesAmountFromSources, loadRetainedCompletedSales, saveRetainedCompletedSales } from '../src/cashier-pos/utils/cashSales.js';

test('counts completed cash and split sales even when the transaction tab is closed', () => {
  const sales = [
    {
      status: 'completed',
      paymentMethod: 'cash',
      totalAmount: 100,
    },
    {
      status: 'completed',
      paymentMethod: 'split',
      splitPayments: { cash: 40, gcash: 60, gcashRef: 'ref' },
    },
  ];

  assert.equal(getCashSalesAmount(sales), 140);
});

test('ignores voided sales when calculating cash sales', () => {
  const sales = [
    {
      status: 'voided',
      paymentMethod: 'cash',
      totalAmount: 100,
    },
    {
      status: 'completed',
      paymentMethod: 'cash',
      totalAmount: 75,
    },
  ];

  assert.equal(getCashSalesAmount(sales), 75);
});

test('counts completed sales that use a completed-like raw status instead of a lowercase status', () => {
  const sales = [
    {
      rawStatus: 'completed',
      paymentMethod: 'cash',
      totalAmount: 180,
    },
    {
      status: 'Completed',
      paymentMethod: 'split',
      splitPayments: { cash: 45 },
    },
  ];

  assert.equal(getCashSalesAmount(sales), 225);
});

test('keeps cash sales from a closed transaction tab when a retained ledger is used', () => {
  assert.equal(getCashSalesAmountFromSources({
    retainedSales: [{ paymentMethod: 'cash', totalAmount: 120, rawStatus: 'completed' }],
    currentSales: [],
    historySales: [],
  }), 120);
});

test('does not double-count a completed sale when it exists in both retained and current sales', () => {
  const sameSale = { saleId: 'sale-1', paymentMethod: 'cash', totalAmount: 180, rawStatus: 'completed' };

  assert.equal(getCashSalesAmountFromSources({
    retainedSales: [sameSale],
    currentSales: [sameSale],
    historySales: [],
  }), 180);
});

test('only includes completed sales from the logged-in cashier', () => {
  assert.equal(getCashSalesAmountFromSources({
    retainedSales: [
      { saleId: 'sale-1', cashierId: 'cashier-a', paymentMethod: 'cash', totalAmount: 120, rawStatus: 'completed' },
    ],
    currentSales: [
      { saleId: 'sale-2', cashierId: 'cashier-b', paymentMethod: 'cash', totalAmount: 300, rawStatus: 'completed' },
      { saleId: 'sale-3', cashierId: 'cashier-a', paymentMethod: 'split', splitPayments: { cash: 80 }, rawStatus: 'completed' },
    ],
    historySales: [],
    cashierId: 'cashier-a',
  }), 200);
});

test('persists retained completed sales to local storage and restores them for the same cashier', () => {
  const store = new Map();
  const localStorageStub = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };

  global.localStorage = localStorageStub;

  const sales = [{ saleId: 'sale-100', paymentMethod: 'cash', totalAmount: 250, rawStatus: 'completed' }];
  saveRetainedCompletedSales(sales, 'cashier-a');

  assert.deepEqual(loadRetainedCompletedSales('cashier-a'), [{ ...sales[0], cashierId: 'cashier-a' }]);
  assert.deepEqual(loadRetainedCompletedSales('cashier-b'), []);
});
