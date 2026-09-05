import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { groupSaleItemsBySaleId } = await import('../server/index.js')

test('groupSaleItemsBySaleId groups items under their sale_id', () => {
  const items = [
    { id: 'i1', sale_id: 'sale1', quantity_sold: 2 },
    { id: 'i2', sale_id: 'sale1', quantity_sold: 1 },
    { id: 'i3', sale_id: 'sale2', quantity_sold: 5 },
  ]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.size, 2)
  assert.deepEqual(grouped.get('sale1').map((item) => item.id), ['i1', 'i2'])
  assert.deepEqual(grouped.get('sale2').map((item) => item.id), ['i3'])
})

test('groupSaleItemsBySaleId handles a relation field expanded as a one-element array', () => {
  // PocketBase relation fields sometimes arrive as [id] instead of a bare
  // id string depending on the query -- productRelationId/dashboardSaleSource
  // elsewhere in server/index.js already handle this same shape.
  const items = [{ id: 'i1', sale_id: ['sale1'], quantity_sold: 2 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.deepEqual(grouped.get('sale1').map((item) => item.id), ['i1'])
})

test('groupSaleItemsBySaleId skips items with no sale_id rather than throwing', () => {
  const items = [{ id: 'i1', sale_id: '', quantity_sold: 2 }, { id: 'i2', sale_id: null, quantity_sold: 1 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.size, 0)
})

test('groupSaleItemsBySaleId returns an empty map for an empty input', () => {
  assert.equal(groupSaleItemsBySaleId([]).size, 0)
})
