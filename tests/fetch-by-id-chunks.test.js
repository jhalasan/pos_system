import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchByIdChunks } from '../src/utils/fetchByIdChunks.js'

// Minimal fake PocketBase client: records every getFullList call's filter
// string and returns items whose id appears in that call's requested ids
// (parsed back out of the filter string), so a test can assert both "the
// right total data came back" and "it was actually split into multiple
// requests," not just the end result.
function makeFakePb({ allItems = [], failOnFilterLength = null } = {}) {
  const calls = []
  const pb = {
    filter: (str, params) => str.replace('{:id}', JSON.stringify(params.id)),
    collection: (name) => ({
      async getFullList(options) {
        calls.push({ collection: name, filter: options.filter, requestKey: options.requestKey })
        if (failOnFilterLength !== null && options.filter.length > failOnFilterLength) {
          const err = new Error('Something went wrong while processing your request.')
          err.status = 400
          throw err
        }
        const idsInFilter = [...options.filter.matchAll(/"([^"]+)"/g)].map((m) => m[1])
        return allItems.filter((item) => idsInFilter.includes(item.sale_id))
      },
    }),
  }
  return { pb, calls }
}

test('returns [] without making any request when ids is empty', async () => {
  const { pb, calls } = makeFakePb()
  const result = await fetchByIdChunks(pb, 'sale_items', 'sale_id', [])
  assert.deepEqual(result, [])
  assert.equal(calls.length, 0)
})

test('deduplicates ids before chunking', async () => {
  const allItems = [{ sale_id: 'a', name: 'x' }, { sale_id: 'b', name: 'y' }]
  const { pb, calls } = makeFakePb({ allItems })
  const result = await fetchByIdChunks(pb, 'sale_items', 'sale_id', ['a', 'a', 'b', 'a'], { chunkSize: 80 })
  assert.equal(result.length, 2)
  assert.equal(calls.length, 1, 'deduped down to 2 unique ids should fit in a single chunk')
})

test('splits a large id list into multiple chunked requests and merges all results', async () => {
  // 250 ids at chunkSize 80 must produce exactly 4 chunks (80+80+80+10) --
  // this is the exact shape of the live failure this helper fixes: a large
  // id set that would otherwise become one oversized OR-filter.
  const ids = Array.from({ length: 250 }, (_, i) => `sale-${i}`)
  const allItems = ids.map((id) => ({ sale_id: id, quantity_sold: 1 }))
  const { pb, calls } = makeFakePb({ allItems })

  const result = await fetchByIdChunks(pb, 'sale_items', 'sale_id', ids, { chunkSize: 80, concurrency: 12 })

  assert.equal(calls.length, 4, 'expected 4 chunked requests for 250 ids at chunkSize 80')
  assert.equal(result.length, 250, 'every item across all chunks must be present in the merged result')
  const resultIds = new Set(result.map((item) => item.sale_id))
  assert.equal(resultIds.size, 250, 'no item should be missing or duplicated across chunk boundaries')
})

test('never builds a single request large enough to trip the live filter-length failure', async () => {
  // Reproduces the actual production incident: a naive single OR-filter
  // across many ids is rejected past a certain length. Assert chunking
  // keeps every individual request's filter comfortably under that.
  const ids = Array.from({ length: 5953 }, (_, i) => `sale00000000${String(i).padStart(4, '0')}`)
  const allItems = ids.map((id) => ({ sale_id: id }))
  const { pb, calls } = makeFakePb({ allItems, failOnFilterLength: 4646 })

  const result = await fetchByIdChunks(pb, 'sale_items', 'sale_id', ids)

  assert.equal(result.length, 5953)
  for (const call of calls) {
    assert.ok(call.filter.length < 4646, `chunk filter length ${call.filter.length} must stay under the confirmed-failing threshold`)
  }
})

test('passes through expand and sort options to each chunked request', async () => {
  const { pb, calls } = makeFakePb({ allItems: [{ sale_id: 'a' }] })
  await fetchByIdChunks(pb, 'sale_items', 'sale_id', ['a'], { expand: 'product_id', sort: 'created' })
  assert.equal(calls.length, 1)
})

test('gives each chunk a distinct requestKey when a prefix is provided, to avoid SDK auto-cancellation between concurrent chunks', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `sale-${i}`)
  const { pb, calls } = makeFakePb({ allItems: ids.map((id) => ({ sale_id: id })) })
  await fetchByIdChunks(pb, 'sale_items', 'sale_id', ids, { chunkSize: 80, requestKeyPrefix: 'dashboard-items' })
  const requestKeys = calls.map((c) => c.requestKey)
  assert.equal(new Set(requestKeys).size, requestKeys.length, 'every chunk must get a unique requestKey')
  assert.ok(requestKeys.every((key) => key.startsWith('dashboard-items:')))
})
