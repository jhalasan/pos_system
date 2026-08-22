import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPendingStockOps } from '../src/admin-page/offline/syncEngine.js'

// Reproduces the live production bug reported after a Stock Count on
// MARLBORO RED ORIGINAL: entering "1600" showed 0 pieces on the first
// attempt, then 1589 on a second attempt with the same input. Root cause:
// adjustInventoryCount (a physical stock COUNT) was folded as a DELTA on top
// of whatever the cloud/local baseline happened to be at apply time, so
// several queued/duplicate count attempts (each computed against a
// possibly-stale baseline) compounded on top of each other instead of all
// converging on the same intended absolute value.

test('scanInventory and stockOutInventory still apply as relative deltas', () => {
  const ops = [
    { type: 'scanInventory', payload: { qty: 10 }, createdAt: 1 },
    { type: 'stockOutInventory', payload: { qty: 4 }, createdAt: 2 },
  ]
  assert.equal(applyPendingStockOps(100, ops), 106)
})

test('adjustInventoryCount is applied as an ABSOLUTE value, not a delta on top of the base quantity', () => {
  const ops = [
    { type: 'adjustInventoryCount', payload: { countedQty: 1600, delta: -692 }, createdAt: 1 },
  ]
  // Base quantity here simulates a cloud value that has already drifted away
  // from what the count's delta was computed against (e.g. 2292 at queue
  // time, but the cloud is something else by the time this op applies).
  // The absolute countedQty must win regardless of the stale base.
  assert.equal(applyPendingStockOps(908, ops), 1600)
})

test('three duplicate/retried "count = 1600" attempts converge on 1600, not a compounding chain', () => {
  // This is the exact production sequence: three stock-count attempts, each
  // computed client-side against a previousQty of 2292 (frozen by the
  // separate reconciler bug), all still queued when they finally get
  // processed. Delta-based folding produced 1600 -> 908 -> 216. Absolute
  // application must produce 1600 all three times.
  const ops = [
    { type: 'adjustInventoryCount', payload: { countedQty: 1600, delta: -692 }, createdAt: 1 },
    { type: 'adjustInventoryCount', payload: { countedQty: 1600, delta: -692 }, createdAt: 2 },
    { type: 'adjustInventoryCount', payload: { countedQty: 1600, delta: -692 }, createdAt: 3 },
  ]
  assert.equal(applyPendingStockOps(2292, ops), 1600)
})

test('a later adjustInventoryCount supersedes an earlier one, regardless of array order', () => {
  const outOfOrder = [
    { type: 'adjustInventoryCount', payload: { countedQty: 500 }, createdAt: 2 },
    { type: 'adjustInventoryCount', payload: { countedQty: 1600 }, createdAt: 1 },
  ]
  assert.equal(applyPendingStockOps(0, outOfOrder), 500, 'sorted by createdAt: 1600 first, then 500 wins')
})

test('a scan queued after a count stacks on top of the count\'s absolute value, not the original base', () => {
  const ops = [
    { type: 'adjustInventoryCount', payload: { countedQty: 1600 }, createdAt: 1 },
    { type: 'scanInventory', payload: { qty: 50 }, createdAt: 2 },
  ]
  assert.equal(applyPendingStockOps(2292, ops), 1650)
})

test('a malformed countedQty does not corrupt the running quantity', () => {
  const ops = [{ type: 'adjustInventoryCount', payload: {}, createdAt: 1 }]
  assert.equal(applyPendingStockOps(500, ops), 500)
})

test('an empty ops list returns the base quantity unchanged', () => {
  assert.equal(applyPendingStockOps(500, []), 500)
})
