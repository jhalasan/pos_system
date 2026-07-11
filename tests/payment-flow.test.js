import test from 'node:test';
import assert from 'node:assert/strict';
import { getPostChangeFlowStep } from '../src/cashier-pos/utils/paymentFlow.js';

test('continue to receipt if the cash drawer cannot be opened after a cash sale', () => {
  assert.equal(getPostChangeFlowStep({ method: 'cash', splitCash: 0, drawerOpenSucceeded: false }), 'receipt');
});

test('stay on the register step when the cash drawer opens for a cash sale', () => {
  assert.equal(getPostChangeFlowStep({ method: 'cash', splitCash: 0, drawerOpenSucceeded: true }), 'register');
});

test('skip the register step for GCash payments', () => {
  assert.equal(getPostChangeFlowStep({ method: 'gcash', splitCash: 0, drawerOpenSucceeded: true }), 'receipt');
});
