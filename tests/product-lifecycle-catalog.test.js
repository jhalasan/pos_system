import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCatalogActive, isSellable } from '../src/utils/productLifecycle.js'

// Inventory's "Total Products" stat and Dashboard's stock-related stats used
// to count archived/deleted products (see M9 in POS_AUDIT_REGISTER.md for
// how a product ends up in that state instead of being hard-deleted).

test('a product with no lifecycle status is active by default', () => {
  assert.equal(isCatalogActive({}), true)
})

test('an explicitly active product is active', () => {
  assert.equal(isCatalogActive({ lifecycleStatus: 'active' }), true)
})

test('an inactive product still counts as active catalog (temporarily disabled, not removed)', () => {
  assert.equal(isCatalogActive({ lifecycleStatus: 'inactive' }), true)
})

test('an archived product is excluded', () => {
  assert.equal(isCatalogActive({ lifecycleStatus: 'archived' }), false)
})

test('a deleted product is excluded', () => {
  assert.equal(isCatalogActive({ lifecycleStatus: 'deleted' }), false)
})

test('the snake_case field name from raw PocketBase records is also honored', () => {
  assert.equal(isCatalogActive({ lifecycle_status: 'archived' }), false)
  assert.equal(isCatalogActive({ lifecycle_status: 'active' }), true)
})

// isSellable is deliberately stricter than isCatalogActive: an admin marking
// a product "Inactive" (ProductManagement's own "Mark Inactive" action)
// must stop it from being sold, even though it stays IN the catalog for
// stats/reporting purposes. Root-caused from a real inconsistency: the
// desktop cashier already enforced this via its own inline check, but the
// web-mode (Vercel) cashier route used isCatalogActive instead, so an
// "Inactive" product stayed scannable and sellable there.

test('a product with no lifecycle status is sellable by default', () => {
  assert.equal(isSellable({}), true)
})

test('an explicitly active product is sellable', () => {
  assert.equal(isSellable({ lifecycleStatus: 'active' }), true)
})

test('an inactive product is NOT sellable, unlike isCatalogActive', () => {
  assert.equal(isSellable({ lifecycleStatus: 'inactive' }), false)
})

test('an archived product is not sellable', () => {
  assert.equal(isSellable({ lifecycleStatus: 'archived' }), false)
})

test('a deleted product is not sellable', () => {
  assert.equal(isSellable({ lifecycleStatus: 'deleted' }), false)
})

test('isSellable also honors the snake_case field name from raw PocketBase records', () => {
  assert.equal(isSellable({ lifecycle_status: 'inactive' }), false)
  assert.equal(isSellable({ lifecycle_status: 'active' }), true)
})
