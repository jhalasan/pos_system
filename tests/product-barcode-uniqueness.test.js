import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { matchProductBarcodeOwner } = await import('../server/index.js')

// Only a product's main `barcode` field is protected by a database-level
// unique index (idx_products_barcode_nonempty) -- selling-unit barcodes
// (used for case/tie/pack price tiers) have no such constraint anywhere.
// A live production scan found 20 real cases of a selling-unit barcode
// silently colliding with a different product's barcode (e.g. a "RIM"
// wholesale variant's unit barcode matching a retail product's main
// barcode), which is exactly the class of bug behind "scan X, get Y"
// mixups. matchProductBarcodeOwner is the pure lookup both admin surfaces
// (Tauri desktopApi.js and this web route) now run before saving a product.

function product(id, overrides = {}) {
  return { id, name: id, barcode: '', selling_units: [], ...overrides }
}

test('returns null when no barcode collides with any other product', () => {
  const records = [
    product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' }),
    product('p2', { name: 'WINSTON RED', barcode: '48040594' }),
  ]
  assert.equal(matchProductBarcodeOwner(records, ['999999999']), null)
})

test('catches a main barcode colliding with a different product\'s main barcode', () => {
  const records = [
    product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' }),
  ]
  const hit = matchProductBarcodeOwner(records, ['4806504613212'])
  assert.equal(hit.product.name, 'MARLBORO RED ORIGINAL')
  assert.equal(hit.barcode, '4806504613212')
})

test('catches a selling-unit barcode colliding with a different product\'s main barcode', () => {
  // Reproduces the real production pattern: "WM RED ORIGINAL RIM"'s own
  // selling-unit barcode is the same code as "MARLBORO RED ORIGINAL"'s main
  // barcode -- the exact WMRED/MARLBORO collision found live.
  const records = [
    product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' }),
  ]
  const submittedBarcodes = ['9990001', '4806504613212']
  const hit = matchProductBarcodeOwner(records, submittedBarcodes)
  assert.equal(hit.product.name, 'MARLBORO RED ORIGINAL')
  assert.equal(hit.barcode, '4806504613212')
})

test('catches a collision against another product\'s selling-unit barcode too, not just its main one', () => {
  const records = [
    product('p1', { name: 'BEAR BRAND CHOCO 33g', barcode: '4800361409117', selling_units: [
      { barcode: '4800361409117', unit: 'Piece', conversion: 1 },
      { barcode: '4800361431361', unit: 'TIE', conversion: 10 },
    ] }),
  ]
  const hit = matchProductBarcodeOwner(records, ['4800361431361'])
  assert.equal(hit.product.name, 'BEAR BRAND CHOCO 33g')
  assert.equal(hit.barcode, '4800361431361')
})

test('a product does not collide with its own barcodes when excludeId matches (editing)', () => {
  const records = [
    product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' }),
  ]
  assert.equal(matchProductBarcodeOwner(records, ['4806504613212'], 'p1'), null)
})

test('a DIFFERENT product still collides even when excludeId is set for the one being edited', () => {
  const records = [
    product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' }),
    product('p2', { name: 'WINSTON RED', barcode: '48040594' }),
  ]
  const hit = matchProductBarcodeOwner(records, ['48040594'], 'p1')
  assert.equal(hit.product.name, 'WINSTON RED')
})

test('an empty/blank barcode list never matches anything', () => {
  const records = [product('p1', { name: 'MARLBORO RED ORIGINAL', barcode: '4806504613212' })]
  assert.equal(matchProductBarcodeOwner(records, ['', null, undefined]), null)
  assert.equal(matchProductBarcodeOwner(records, []), null)
})
