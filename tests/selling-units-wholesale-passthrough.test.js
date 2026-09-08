import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSellingUnits } from '../src/utils/sellingUnits.js'

// Regression test for a live client report: a product's separate wholesale
// price (set in Product Management, e.g. "Use a separate wholesale price"
// checkbox) was invisible in the cashier POS. Root cause: normalizeSellingUnits
// here is the shared base normalizer that Cashier.jsx's own richer wrapper
// (Cashier.jsx's local normalizeSellingUnits) builds on top of -- but this
// base normalizer was dropping `wholesalePrice` and `pricingTier` when
// mapping each raw sellingUnits row, so by the time the cashier's wrapper
// checked `unit.wholesalePrice > 0` to decide whether to add a pickable
// "Wholesale" unit option, that value was always 0. This affected both
// single-unit products (one row) and multi-unit products (one row per unit,
// each with its own optional wholesale price).

test('preserves a single unit row\'s wholesalePrice', () => {
  const product = {
    unit: 'Piece',
    barcode: '2976345854704',
    price: 45,
    sellingUnits: [
      { barcode: '2976345854704', unit: 'Piece', conversion: 1, price: 45, wholesalePrice: 33.33, pricingTier: 'retail' },
    ],
  }
  const units = normalizeSellingUnits(product)
  assert.equal(units.length, 1)
  assert.equal(units[0].wholesalePrice, 33.33)
})

test('preserves per-row wholesalePrice across multiple selling units', () => {
  const product = {
    unit: 'Piece',
    barcode: '1111',
    price: 10,
    sellingUnits: [
      { barcode: '1111', unit: 'Piece', conversion: 1, price: 10, wholesalePrice: 8 },
      { barcode: '2222', unit: 'Box', conversion: 12, price: 110, wholesalePrice: 90 },
    ],
  }
  const units = normalizeSellingUnits(product)
  const piece = units.find((u) => u.unit === 'Piece')
  const box = units.find((u) => u.unit === 'Box')
  assert.equal(piece.wholesalePrice, 8)
  assert.equal(box.wholesalePrice, 90)
})

test('defaults wholesalePrice to 0 when a row has none, without throwing', () => {
  const product = {
    unit: 'Piece',
    barcode: '3333',
    price: 20,
    sellingUnits: [{ barcode: '3333', unit: 'Piece', conversion: 1, price: 20 }],
  }
  const units = normalizeSellingUnits(product)
  assert.equal(units[0].wholesalePrice, 0)
})
