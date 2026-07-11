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

test('projects pending stock-outs from the most recent local quantity when the cloud record is stale', () => {
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
      qty: 10,
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
