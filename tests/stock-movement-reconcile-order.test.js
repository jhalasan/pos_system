import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findStockMovement,
  findExistingStockMovementsByReference,
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

// --- stockQuantityFromMovements: chain mismatch (non-blocking) / edge cases

test('a chain mismatch still returns the delta-summed quantity (does not decline, does not throw)', () => {
  // This same previous_quantity/new_quantity mismatch signature can mean a
  // genuine gap OR two terminals writing legitimate concurrent movements off
  // the same shared baseline (the "busy day, two terminals" scenario) — the
  // function cannot tell these apart, so it must not decline to reconcile;
  // it always sums deltas (which is correct in both cases as long as no
  // movement is truly missing) and only logs the mismatch as a diagnostic.
  const movements = [
    { id: 'm1', product_id: 'p1', movement_type: 'sale', previous_quantity: 50, new_quantity: 48 },
    { id: 'm2', product_id: 'p1', movement_type: 'sale', previous_quantity: 45, new_quantity: 44 },
  ];
  // baseline (movements[0].previous_quantity = 50) + delta(m1: 48-50=-2) + delta(m2: 44-45=-1) = 47
  assert.doesNotThrow(() => {
    assert.equal(stockQuantityFromMovements(movements), 47);
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

// --- findExistingStockMovementsByReference: bulk replacement for N calls to
// findStockMovement, one per sale line (T3 request-volume half) -----------

test('returns an empty map without a request when there are no reference ids', async () => {
  let calls = 0;
  const pb = {
    filter: (str) => str,
    collection() {
      calls += 1;
      return { async getList() { return { items: [] }; } };
    },
  };
  const result = await findExistingStockMovementsByReference(pb, []);
  assert.equal(result.size, 0);
  assert.equal(calls, 0, 'must not make any request for an empty input');
});

test('makes exactly one request regardless of how many reference ids are asked for', async () => {
  let calls = 0;
  const pb = {
    filter: (str) => str,
    collection() {
      calls += 1;
      return {
        async getList() {
          return { items: [{ reference_id: 'sale:s1:line-a', id: 'mv1' }] };
        },
      };
    },
  };
  const result = await findExistingStockMovementsByReference(pb, [
    'sale:s1:line-a', 'sale:s1:line-b', 'sale:s1:line-c',
  ]);
  assert.equal(calls, 1, 'one bulk request, not one per reference id');
  assert.equal(result.get('sale:s1:line-a')?.id, 'mv1');
  assert.equal(result.has('sale:s1:line-b'), false);
});

test('deduplicates repeated reference ids before building the request', async () => {
  let requestedFilter = '';
  const pb = {
    filter: (str) => str,
    collection() {
      return {
        async getList(_page, _perPage, options) {
          requestedFilter = options.filter;
          return { items: [] };
        },
      };
    },
  };
  await findExistingStockMovementsByReference(pb, ['sale:s1:line-a', 'sale:s1:line-a']);
  assert.equal(requestedFilter.split('||').length, 1, 'a duplicate reference id must not appear twice in the filter');
});

test('a request failure propagates rather than silently reporting "nothing found"', async () => {
  // Mirrors findStockMovement's own contract (see its comment above): a
  // 429/5xx/network blip must reach the caller's existing retry/backoff, not
  // be swallowed into "no movement exists yet" -- that would let a retry
  // proceed to deduct stock a second time for a line whose true state is
  // simply unknown, not confirmed undeducted.
  const pb = {
    filter: (str) => str,
    collection() {
      return { async getList() { throw new Error('network blip'); } };
    },
  };
  await assert.rejects(
    () => findExistingStockMovementsByReference(pb, ['sale:s1:line-a']),
    (error) => error.message === 'network blip',
  );
});

// --- reconcileProductStock: bounded window + non-blocking mismatch --------

test('reconcileProductStock calls getList (not getFullList) with a bounded perPage, fetching the newest page', async () => {
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
  // Page 1 must be sorted DESCENDING (newest first) -- page 1 of an ASCENDING
  // sort is the OLDEST page once a product has more movements than the
  // window, which is exactly the bug this test guards against: reconciling
  // from a page 1 requires descending order so "page 1" means "most recent."
  assert.equal(capturedOptions.sort, '-created,-created_at');
});

// Reproduces the live production bug found on MARLBORO RED ORIGINAL: a
// product with more than WINDOW_SIZE (50) lifetime movements had its
// quantity permanently frozen at an old value, because reconcileProductStock
// fetched page 1 sorted ASCENDING -- for a product with more than 50 total
// movements, that is the OLDEST 50, not a recent window. Every operation's
// correct products.update() got immediately overwritten back to the stale,
// decades-old total the instant reconcileProductStock ran afterward.
test('reconcileProductStock uses the MOST RECENT window, not the oldest, once a product exceeds the window size', async () => {
  // Simulate a product with 60 lifetime movements. The oldest 10 (which must
  // be excluded) chain from 0 up to 500 -- if the buggy ascending/page-1
  // query were still in play, the reconciler would anchor on movement #0
  // (previous_quantity 0) and only sum through movement #49, landing on a
  // stale total instead of the true current value.
  const oldestExcluded = [];
  let running = 0;
  for (let i = 0; i < 10; i += 1) {
    const next = running + 50;
    oldestExcluded.push({ id: `old-${i}`, movement_type: 'stock_in', previous_quantity: running, new_quantity: next });
    running = next;
  }
  // running === 500 here -- the true baseline the recent window must anchor on.

  // The most recent 50 movements: a long run of small sales bringing the
  // product from 500 down to 100 (i.e. the real, current, post-reconciliation
  // total every fresh operation has been correctly computing all along).
  const recentAscending = [];
  for (let i = 0; i < 50; i += 1) {
    const next = running - 8;
    recentAscending.push({ id: `recent-${i}`, movement_type: 'sale', previous_quantity: running, new_quantity: next });
    running = next;
  }
  const trueCurrentQuantity = running; // 500 - 50*8 = 100

  const fakePb = {
    filter: (str) => str,
    collection(name) {
      if (name === 'stock_movements') {
        return {
          async getList(page, perPage, options) {
            assert.equal(page, 1);
            assert.equal(options.sort, '-created,-created_at');
            // A real PocketBase getList with a descending sort returns
            // newest-first; reconcileProductStock is responsible for
            // reversing this back to ascending before summing.
            return { items: recentAscending.slice().reverse() };
          },
        };
      }
      if (name === 'products') {
        return {
          // Simulates the exact production symptom: an operation just wrote
          // the correct new value (100), but a stale reconcile would revert it.
          async getOne() {
            return { quantity: String(trueCurrentQuantity) };
          },
          async update() {
            throw new Error('must not "correct" an already-correct recent quantity back to a stale oldest-window total');
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const quantity = await reconcileProductStock(fakePb, 'p1');
  assert.equal(quantity, trueCurrentQuantity, 'must reconcile from the recent window, not the oldest-excluded movements');
});

test('reconcileProductStock still reconciles (calls products.update with the summed quantity) when the chain has a mismatch', async () => {
  let updateCalls = 0;
  let updatedPayload = null;
  const fakePb = {
    filter: (str) => str,
    collection(name) {
      if (name === 'stock_movements') {
        return {
          async getList() {
            // reconcileProductStock now requests -created,-created_at (newest
            // first) and reverses the result itself -- return newest-first
            // here (m2 before m1) to match that real-PocketBase contract.
            return {
              items: [
                { id: 'm2', product_id: 'p1', movement_type: 'sale', previous_quantity: 45, new_quantity: 44 },
                { id: 'm1', product_id: 'p1', movement_type: 'sale', previous_quantity: 50, new_quantity: 48 },
              ],
            };
          },
        };
      }
      if (name === 'products') {
        return {
          async getOne() {
            // Stale/racy value already on the product record, different
            // from the correct summed total (47), so update must fire.
            return { quantity: '50' };
          },
          async update(id, payload) {
            updateCalls += 1;
            updatedPayload = payload;
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const result = await reconcileProductStock(fakePb, 'p1');
  assert.equal(result, 47);
  assert.equal(updateCalls, 1);
  assert.equal(updatedPayload.quantity, '47');
});
