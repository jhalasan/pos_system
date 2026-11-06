import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseSellableUnit } from '../src/cashier-pos/offline/stockUtils.js'

// Client report: an item sold by the ream cannot be added by clicking it once
// fewer than a full ream is left (e.g. 3x10 cellophane with 15 pieces), though
// scanning the piece barcode works. Clicking started from the first unit (the
// ream), found 0 reams available, and stopped with "out of stock".

const ream = { unit: 'Ream', conversion: 500, price: 900, barcode: 'REAM1' }
const piece = { unit: 'Piece', conversion: 1, price: 2, barcode: 'PIECE1' }
const units = [ream, piece]

test('less than one ream left: the click offers the piece unit instead of refusing', () => {
  assert.equal(chooseSellableUnit({ qty: 15 }, units, ream), piece)
})

test('a full ream or more left: the first unit is still the default', () => {
  assert.equal(chooseSellableUnit({ qty: 500 }, units, ream), ream)
  assert.equal(chooseSellableUnit({ qty: 1200 }, units, ream), ream)
})

test('499 pieces (one short of a ream) offers pieces', () => {
  assert.equal(chooseSellableUnit({ qty: 499 }, units, ream), piece)
})

test('truly out of stock: the default unit is returned so the message names the usual unit', () => {
  assert.equal(chooseSellableUnit({ qty: 0 }, units, ream), ream)
})

test('a single-unit item behaves as before', () => {
  assert.equal(chooseSellableUnit({ qty: 3 }, [piece], piece), piece)
  assert.equal(chooseSellableUnit({ qty: 0 }, [piece], piece), piece)
})

test('three units: picks the first one that has stock, in list order', () => {
  const box = { unit: 'Box', conversion: 50, price: 100 }
  assert.equal(chooseSellableUnit({ qty: 60 }, [ream, box, piece], ream), box)
  assert.equal(chooseSellableUnit({ qty: 20 }, [ream, box, piece], ream), piece)
})

test('no units at all does not throw', () => {
  assert.equal(chooseSellableUnit({ qty: 5 }, [], null), null)
})
