import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProductStock } from '../src/utils/stockMovementReconciler.js';

// Regression coverage for a live incident (WILKINS PURE 500ml CASE,
// 2026-09-07): a Stock In of 20 cases was immediately wiped back down to 0
// by reconcileProductStock. Root cause, confirmed by replaying the actual
// production movement ledger: the product was under constant concurrent
// multi-terminal sale traffic, and the reconciler's fixed 50-movement window
// anchored on a movement whose own previous_quantity was itself the product
// of a stale concurrent read (nine separate movements in the real ledger
// independently recorded previous_quantity=43, none of them trustworthy).
// Delta-summing forward from a bad anchor produced a number with no
// relationship to reality -- in the real incident, exactly 0.
//
// The fix: anchor on the most recent movement_type='adjustment' (a Stock
// Count, or the one-time PocketHost-merge event) instead of an arbitrary
// window boundary, and sum every real movement's own recorded `quantity`
// (immune to a stale previous_quantity/new_quantity read) since that point.

function fakePb({ anchor, sinceAnchor = [], productQuantity, onUpdate } = {}) {
  const collections = {
    stock_movements: {
      async getFirstListItem(filter) {
        if (!anchor) {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        return anchor;
      },
      async getList(page, perPage, options) {
        return { items: sinceAnchor };
      },
    },
    products: {
      async getOne() {
        return { quantity: String(productQuantity) };
      },
      async update(id, payload) {
        onUpdate?.(payload);
      },
    },
  };
  return {
    filter: (str) => str,
    collection: (name) => collections[name],
  };
}

test('anchors on the last Stock Count instead of a stale concurrent-write window, recovering a Stock In that a broken window would have wiped out', async () => {
  // Reproduces the WILKINS incident's actual shape: a Stock Count declared
  // 204 recently; nine concurrent sale movements since then all raced off
  // stale reads of the SAME (wrong) previous_quantity/new_quantity pairs --
  // exactly what happened live -- but each one's own `quantity` field (the
  // real magnitude of that sale) is untouched by the race. Then a Stock In
  // of 20 (cases, already converted to base units by the caller) lands.
  const anchor = { created: '2026-09-05T11:23:08Z', new_quantity: 204, movement_type: 'adjustment' };
  const racyPreviousNew = { previous_quantity: 43, new_quantity: 43 }; // deliberately wrong/stale on every entry, like the real ledger
  const sinceAnchor = [
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 12, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 12, ...racyPreviousNew },
    { movement_type: 'sale', quantity: 24, ...racyPreviousNew },
    // The Stock In itself -- also racing off the same stale baseline
    // (previous_quantity: 0, new_quantity: 20 in the real incident), but its
    // `quantity` of 20 is still the true, trustworthy magnitude.
    { movement_type: 'stock_in', quantity: 20, previous_quantity: 0, new_quantity: 20 },
  ];
  // 204 - (24+24+12+24+24+24+24+12+24) + 20 = 204 - 192 + 20 = 32... wait,
  // matches the live incident's own numbers instead: 204 minus nine sales
  // totalling 192 leaves 12, plus the stock-in's 20 = 32. This intentionally
  // does not need to match the live incident's specific totals -- it only
  // needs to prove the reconciled result is a sane forward sum from the
  // trusted anchor, not the old algorithm's 0.
  let updated = null;
  const pb = fakePb({ anchor, sinceAnchor, productQuantity: 0, onUpdate: (payload) => { updated = payload } });

  const quantity = await reconcileProductStock(pb, 'wilkins-500-case');

  assert.equal(quantity, 32, 'must sum forward from the trusted Stock Count anchor using each movement\'s own quantity, not a stale previous/new chain');
  assert.equal(updated?.quantity, '32');
});

test('a Stock In right after the anchor is preserved exactly when nothing else happened since', async () => {
  const anchor = { created: '2026-09-01T00:00:00Z', new_quantity: 100, movement_type: 'adjustment' };
  const sinceAnchor = [
    { movement_type: 'stock_in', quantity: 480, previous_quantity: 0, new_quantity: 480 }, // stale/wrong previous_quantity, correct quantity
  ];
  let updated = null;
  const pb = fakePb({ anchor, sinceAnchor, productQuantity: 0, onUpdate: (payload) => { updated = payload } });

  const quantity = await reconcileProductStock(pb, 'p1');

  assert.equal(quantity, 580, '100 (counted) + 480 (stock-in) -- must not collapse to the stock-in\'s own wrong previous/new pair (0 -> 480)');
  assert.equal(updated?.quantity, '580');
});

test('falls back to the windowed heuristic when no Stock Count has ever been recorded', async () => {
  const pb = fakePb({
    anchor: null,
    productQuantity: 5,
    onUpdate: () => { throw new Error('must not be called: product.quantity already matches the fallback window result') },
  });
  // getList is only reached via the fallback path here since no anchor exists.
  pb.collection('stock_movements').getList = async () => ({
    items: [{ movement_type: 'stock_in', quantity: 5, previous_quantity: 0, new_quantity: 5 }],
  });

  const quantity = await reconcileProductStock(pb, 'p1');
  assert.equal(quantity, 5);
});
