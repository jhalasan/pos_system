import assert from 'node:assert/strict'
import test from 'node:test'
import { groupSaleItemsBySaleId } from '../src/utils/saleItemGrouping.js'

test('groups items under their sale_id', () => {
  const items = [
    { id: 'i1', sale_id: 'sale-a', quantity_sold: 1 },
    { id: 'i2', sale_id: 'sale-a', quantity_sold: 2 },
    { id: 'i3', sale_id: 'sale-b', quantity_sold: 3 },
  ]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.get('sale-a').length, 2)
  assert.equal(grouped.get('sale-b').length, 1)
  assert.equal(grouped.get('sale-c'), undefined)
})

test('unwraps a relation array (PocketBase sometimes expands sale_id as [id])', () => {
  const items = [{ id: 'i1', sale_id: ['sale-a'], quantity_sold: 1 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.get('sale-a').length, 1)
})

test('accepts camelCase saleId as a fallback', () => {
  const items = [{ id: 'i1', saleId: 'sale-a', quantity: 1 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.get('sale-a').length, 1)
})

test('an item with no sale reference at all is dropped, not thrown', () => {
  const items = [{ id: 'i1' }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.size, 0)
})
