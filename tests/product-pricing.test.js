import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRequiredProductPrice } from '../src/admin-page/offline/productPricing.js'

test('keeps an explicit positive product price', () => {
  assert.equal(resolveRequiredProductPrice({ price: 12.5 }), 12.5)
})

test('repairs a blank queued price from the base selling unit', () => {
  assert.equal(resolveRequiredProductPrice({
    price: '',
    sellingUnits: [{ unit: 'Stick', conversion: 1, price: 9 }],
  }), 9)
})

test('derives a base price from another selling unit', () => {
  assert.equal(resolveRequiredProductPrice({
    price: 0,
    sellingUnits: [{ unit: 'Pack', conversion: 20, price: 180 }],
  }), 9)
})

test('always supplies PocketBase with a nonblank required price', () => {
  assert.equal(resolveRequiredProductPrice({ price: 0, cost: 0 }), 0.01)
})
