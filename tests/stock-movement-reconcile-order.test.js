import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findStockMovement,
  stockQuantityFromMovements,
  reconcileProductStock,
} from '../src/utils/stockMovementReconciler.js';

// --- stockQuantityFromMovements: intact chains ---------------------------

test('an intact chain returns the last movement new_quantity (fractional stock-ins)', () => {
  const movements = [
    { movement_type: 'stock_in', quantity: 0.1, previous_quantity: 0, new_quantity: 0.1 },
    { movement_type: 'stock_in', quantity: 0.2, previous_quantity: 0.1, new_quantity: 0.3 },
  ];
  assert.equal(stockQuantityFromMovements(movements), 0.3);
});

test('an intact chain returns the last movement new_quantity (sale then void)', () => {
  const movements = [
    { movement_type: 'sale', quantity: 1.75, previous_quantity: 50, new_quantity: 48.25 },
    { movement_type: 'void_return', quantity: 1.75, previous_quantity: 48.25, new_quantity: 50 },
  ];
  assert.equal(stockQuantityFromMovements(movements), 50);
});

test('an intact chain of many small fractional movements does not drift', () => {
  let qty = 10;
  const movements = [];
  for (let i = 0; i < 10; i += 1) {
    const next = Math.round((qty - 0.1) * 1000) / 1000;
    movements.push({ movement_type: 'stock_out', quantity: 0.1, previous_quantity: qty, new_quantity: next });
    qty = next;
  }
  assert.equal(stockQuantityFromMovements(movements), 9);
});

// --- stockQuantityFromMovements: broken chain / edge cases ---------------

test('a broken chain (previous_quantity mismatch) returns null and does not throw', () => {
  const movements = [
    { id: 'm1', product_id: 'p1', movement_type: 'sale', previous_quantity: 50, new_quantity: 48 },
    // Gap: this movement's previous_quantity (45) does not match the prior
    // movement's new_quantity (48) — e.g. a missing movement in between.
    { id: 'm2', product_id: 'p1', movement_type: 'sale', previous_quantity: 45, new_quantity: 44 },
  ];
  assert.doesNotThrow(() => {
    assert.equal(stockQuantityFromMovements(movements), null);
  });
});

test('a single-movement array is trivially intact and returns its new_quantity', () => {
  const movements = [{ movement_type: 'stock_in', previous_quantity: 0, new_quantity: 5 }];
  assert.equal(stockQuantityFromMovements(movements), 5);
});

test('an empty array returns null', () => {
  assert.equal(stockQuantityFromMovements([]), null);
});

// --- findStockMovement -----------------------------------------------------

function fakePbWithGetFirstListItem(status) {
  return {
    filter: (str) => str,
    collection() {
      return {
        async getFirstListItem() {
          const err = new Error('boom');
          err.status = status;
          throw err;
        },
      };
    },
  };
}

test('findStockMovement resolves to null on a 404 (no matching movement)', async () => {
  const pb = fakePbWithGetFirstListItem(404);
  const result = await findStockMovement(pb, 'product1', 'ref1');
  assert.equal(result, null);
});

test('findStockMovement re-throws on a 429 (rate limit) instead of swallowing it', async () => {
  const pb = fakePbWithGetFirstListItem(429);
  await assert.rejects(() => findStockMovement(pb, 'product1', 'ref1'), (error) => error.status === 429);
});

test('findStockMovement re-throws on any other non-404 error', async () => {
  const pb = fakePbWithGetFirstListItem(500);
  await assert.rejects(() => findStockMovement(pb, 'product1', 'ref1'), (error) => error.status === 500);
});

// --- reconcileProductStock: bounded window + broken-chain safety ----------

test('reconcileProductStock calls getList (not getFullList) with a bounded perPage', async () => {
  let capturedPage = null;
  let capturedPerPage = null;
  let capturedOptions = null;
  const fakePb = {
    filter: (str) => str,
    collection(name) {
      if (name === 'stock_movements') {
        return {
          async getList(page, perPage, options) {
            capturedPage = page;
            capturedPerPage = perPage;
            capturedOptions = options;
            return {
              items: [{ movement_type: 'stock_in', previous_quantity: 0, new_quantity: 5 }],
            };
          },
        };
      }
      if (name === 'products') {
        return {
          async getOne() {
            return { quantity: '5' };
          },
          async update() {
            throw new Error('should not be called in this test since product quantity already matches');
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const quantity = await reconcileProductStock(fakePb, 'product1');
  assert.equal(quantity, 5);
  assert.equal(capturedPage, 1);
  assert.equal(typeof capturedPerPage, 'number');
  assert.ok(capturedPerPage > 0 && capturedPerPage <= 50, 'perPage must be bounded');
  assert.equal(capturedOptions.sort, 'created,created_at');
});

test('reconcileProductStock does not call products.update when the chain is broken', async () => {
  let updateCalls = 0;
  const fakePb = {
    filter: (str) => str,
    collection(name) {
      if (name === 'stock_movements') {
        return {
          async getList() {
            return {
              items: [
                { id: 'm1', product_id: 'p1', movement_type: 'sale', previous_quantity: 50, new_quantity: 48 },
                { id: 'm2', product_id: 'p1', movement_type: 'sale', previous_quantity: 45, new_quantity: 44 },
              ],
            };
          },
        };
      }
      if (name === 'products') {
        return {
          async getOne() {
            throw new Error('getOne should not be called when the chain is broken');
          },
          async update() {
            updateCalls += 1;
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const result = await reconcileProductStock(fakePb, 'p1');
  assert.equal(result, null);
  assert.equal(updateCalls, 0);
});
