import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProductWithCloudRecord } from '../src/admin-page/offline/productSyncUtils.js';

test('keeps a locally deleted product hidden when cloud data is synced back in', () => {
  const merged = mergeProductWithCloudRecord(
    {
      id: 'cloud-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      qty: 5,
      lowStock: 2,
    },
    {
      id: 'local-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      deleted: true,
    },
    [],
  );

  assert.equal(merged.deleted, true);
  assert.equal(merged.pendingSync, true);
});

test('preserves an already-projected local stock-out when the cloud record is stale', () => {
  const merged = mergeProductWithCloudRecord(
    {
      id: 'cloud-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      qty: 0,
      lowStock: 2,
    },
    {
      id: 'local-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      qty: 7,
      pendingSync: true,
    },
    [{
      id: 'op-1',
      type: 'stockOutInventory',
      productId: 'local-1',
      payload: { qty: 3, barcode: '123' },
    }],
  );

  assert.equal(merged.qty, 7);
  assert.equal(merged.pendingSync, true);
});

test('preserves an offline restock when the cloud still reports zero', () => {
  const merged = mergeProductWithCloudRecord(
    { id: 'cloud-1', name: 'Marlboro Red', barcode: '493943', qty: 0, lowStock: 2 },
    { id: 'cloud-1', name: 'Marlboro Red', barcode: '493943', qty: 200, pendingSync: true },
    [{
      id: 'restock-1',
      type: 'scanInventory',
      productId: 'cloud-1',
      payload: { qty: 200, barcode: '493943' },
    }],
  );

  assert.equal(merged.qty, 200);
  assert.equal(merged.pendingSync, true);
});
