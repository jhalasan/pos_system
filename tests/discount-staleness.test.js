import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldClearStaleDiscount } from '../src/cashier-pos/utils/discountStaleness.js'

// M37 (POS_AUDIT_REGISTER.md): a peso discount silently re-based itself if
// the cart changed after manager approval, since it's only ever stored as
// the percent it worked out to against the subtotal at approval time.

test('clears when the cart subtotal has moved since a peso discount was approved', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 10, discountBaseSubtotal: 500, subtotal: 1000 }), true)
})

test('does not clear when the subtotal is unchanged (exact match)', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 10, discountBaseSubtotal: 500, subtotal: 500 }), false)
})

test('does not clear for a genuine percentage discount (discountBaseSubtotal is null by convention)', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 10, discountBaseSubtotal: null, subtotal: 1000 }), false)
})

test('does not clear once the transaction is locked (paid/voided) even if subtotal differs', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: true, discount: 10, discountBaseSubtotal: 500, subtotal: 1000 }), false)
})

test('does not clear when there is no discount to clear', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 0, discountBaseSubtotal: 500, subtotal: 1000 }), false)
})

test('tolerates sub-centavo float noise without clearing (0.005 tolerance)', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 10, discountBaseSubtotal: 500, subtotal: 500.001 }), false)
})

test('a genuine centavo-level change still clears', () => {
  assert.equal(shouldClearStaleDiscount({ isLockedTxn: false, discount: 10, discountBaseSubtotal: 500, subtotal: 500.01 }), true)
})

// Once the guard fires once, discount gets reset to 0 -- confirms the
// effect built on top of this function can never loop: the very next
// evaluation (same subtotal, discount now 0) must return false.
test('re-evaluating immediately after a clear (discount reset to 0) returns false -- no infinite-loop risk', () => {
  const afterClear = { isLockedTxn: false, discount: 0, discountBaseSubtotal: null, subtotal: 1000 }
  assert.equal(shouldClearStaleDiscount(afterClear), false)
})
