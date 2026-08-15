import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCatalogActive } from '../src/utils/productLifecycle.js'

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
