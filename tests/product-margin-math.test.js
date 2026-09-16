import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveBaseUnitCost,
  deriveImpliedMargin,
  deriveSellingPrice,
  rescaleCostForConversionChange,
} from '../src/admin-page/utils/productMarginMath.js'

test('deriveSellingPrice applies margin on top of the per-base-unit cost, scaled by conversion', () => {
  // Cost ₱1000 per Ream of 200 sticks => ₱5/stick. 7% margin.
  assert.equal(deriveSellingPrice(1000, 7, 1, 200), 5.35) // per stick
  assert.equal(deriveSellingPrice(1000, 7, 20, 200), 107) // per pack of 20
  assert.equal(deriveSellingPrice(1000, 7, 200, 200), 1070) // per ream
})

test('deriveImpliedMargin back-solves the same relationship deriveSellingPrice uses', () => {
  assert.equal(deriveImpliedMargin(1000, 200, 5.35), 7)
})

test('deriveImpliedMargin never goes negative (a below-cost manual price clamps to 0%, not a negative margin)', () => {
  assert.equal(deriveImpliedMargin(1000, 200, 1), 0)
})

test('deriveBaseUnitCost is 0 for non-finite or non-positive inputs, never NaN/negative', () => {
  assert.equal(deriveBaseUnitCost(0, 200), 0)
  assert.equal(deriveBaseUnitCost(-5, 200), 0)
  assert.equal(deriveBaseUnitCost(1000, 0), 0)
  assert.equal(deriveBaseUnitCost(1000, -1), 0)
  assert.equal(deriveBaseUnitCost(1000, NaN), 0)
})

// Reproduces the exact client-reported bug: a cost entered while the product
// still reads as one meaning gets silently reinterpreted once
// conversionQuantity changes (applying a Unit Template, or turning Multiple
// Selling Units on/off), producing a near-zero per-base-unit cost and, from
// there, either a nonsense low price at the intended margin, or an absurd
// (300%+) implied margin once the admin manually corrects the price.
test('rescaleCostForConversionChange preserves the real per-base-unit cost across a conversion change', () => {
  // Admin had cost=10 while the product was effectively single-unit
  // (conversionQuantity=1, so cost meant "₱10 per stick"). Applying the
  // Cigarette template jumps conversionQuantity to 200.
  const rescaled = rescaleCostForConversionChange(10, 1, 200)
  assert.equal(rescaled, 2000) // now correctly "₱2000 per ream of 200 sticks"
  assert.equal(deriveBaseUnitCost(rescaled, 200), 10) // still ₱10/stick, unchanged
})

test('without the rescale, the same conversion change would silently corrupt the per-unit cost (documents the bug this fix closes)', () => {
  const costEnteredBeforeTemplateApplied = 10
  const conversionQuantityAfterTemplateApplied = 200
  // This is what deriveBaseUnitCost would have produced pre-fix, when the
  // raw cost value was carried across the conversion change unscaled.
  const corruptedBaseUnitCost = deriveBaseUnitCost(costEnteredBeforeTemplateApplied, conversionQuantityAfterTemplateApplied)
  assert.equal(corruptedBaseUnitCost, 0.05) // ~200x too low -- the reported bug
  // A normal-looking manually-typed price against that corrupted cost
  // produces exactly the class of absurd implied margin the client reported.
  assert.equal(deriveImpliedMargin(costEnteredBeforeTemplateApplied, conversionQuantityAfterTemplateApplied, 3.5), 6900)
})

test('rescaleCostForConversionChange is a no-op when the conversion quantity is unchanged', () => {
  assert.equal(rescaleCostForConversionChange(84, 24, 24), 84)
})

test('rescaleCostForConversionChange is a no-op for zero, negative, or non-finite cost', () => {
  assert.equal(rescaleCostForConversionChange(0, 1, 200), 0)
  assert.equal(rescaleCostForConversionChange(-5, 1, 200), -5)
  assert.equal(rescaleCostForConversionChange(NaN, 1, 200), NaN)
})

test('rescaleCostForConversionChange is a no-op when either conversion quantity is invalid (mid-typing empty field, etc.)', () => {
  assert.equal(rescaleCostForConversionChange(10, 1, ''), 10)
  assert.equal(rescaleCostForConversionChange(10, 1, 0), 10)
  assert.equal(rescaleCostForConversionChange(10, '', 200), 10)
  assert.equal(rescaleCostForConversionChange(10, 0, 200), 10)
})

test('rescaling down (multi-unit turned off, conversionQuantity back to 1) is the exact inverse', () => {
  const rescaledUp = rescaleCostForConversionChange(10, 1, 200)
  const rescaledBackDown = rescaleCostForConversionChange(rescaledUp, 200, 1)
  assert.equal(rescaledBackDown, 10)
})
