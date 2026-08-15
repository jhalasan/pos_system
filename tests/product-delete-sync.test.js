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

test('preserves a queued name/price/lifecycle edit against a cloud snapshot fetched before it synced', () => {
  // Root cause of "I archived/deleted a product and it came right back": a
  // periodic full-catalog pull landing while an updateProduct op was still
  // queued (not yet uploaded) used to spread the stale, pre-edit cloud
  // record and keep only qty from the local side -- silently reverting
  // every other pending field, including lifecycle_status, back to its
  // pre-edit value. See POS_AUDIT_REGISTER.md M9.
  const merged = mergeProductWithCloudRecord(
    {
      id: 'cloud-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      qty: 5,
      lowStock: 2,
      lifecycle_status: 'active',
    },
    {
      id: 'local-1',
      name: 'Coffee 3-in-1',
      barcode: '123',
      qty: 5,
      lifecycleStatus: 'archived',
      pendingSync: true,
    },
    [{
      id: 'op-1',
      type: 'updateProduct',
      productId: 'local-1',
      payload: { lifecycleStatus: 'archived' },
    }],
  );

  assert.equal(merged.lifecycleStatus, 'archived');
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
