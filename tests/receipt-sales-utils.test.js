import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveReceiptCategories,
  summarizeSalesByProduct,
  summarizeByCategory,
  filterReceiptsByProductCategory,
} from '../src/admin-page/utils/receiptSalesUtils.js'

const catalogCategories = [{ id: 'cat1', name: 'Beverages' }, { id: 'cat2', name: 'Snacks' }]
const catalogProducts = [
  { id: 'p1', name: 'Coke 1L', barcode: '1001', category: 'cat1' },
  { id: 'p2', name: 'Chips', barcode: '1002', category: 'cat2' },
]

test('resolveReceiptCategories resolves a category id to its display name', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Coke 1L', category: 'cat1', quantity: 2, price: 50 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Beverages')
})

test('resolveReceiptCategories falls back to the product catalog when item category is missing', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Chips', barcode: '1002', category: '', quantity: 1, price: 20 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Snacks')
})

test('resolveReceiptCategories falls back to Uncategorized (Legacy) when nothing matches', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Mystery Item', category: '', quantity: 1, price: 10 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Uncategorized (Legacy)')
})

test('summarizeSalesByProduct aggregates quantity and revenue per product, sorted by revenue desc', () => {
  const receipts = [
    { items: [{ name: 'Coke 1L', category: 'Beverages', quantity: 2, price: 50 }] },
    { items: [{ name: 'Coke 1L', category: 'Beverages', quantity: 1, price: 50 }] },
    { items: [{ name: 'Chips', category: 'Snacks', quantity: 5, price: 20 }] },
  ]
  const summary = summarizeSalesByProduct(receipts)
  assert.deepEqual(summary, [
    { category: 'Snacks', product: 'Chips', quantity: 5, revenue: 100 },
    { category: 'Beverages', product: 'Coke 1L', quantity: 3, revenue: 150 },
  ].sort((a, b) => b.revenue - a.revenue))
})

test('summarizeByCategory rolls a product summary up to category totals', () => {
  const productSummary = [
    { category: 'Beverages', product: 'Coke 1L', quantity: 3, revenue: 150 },
    { category: 'Beverages', product: 'Sprite 1L', quantity: 1, revenue: 45 },
    { category: 'Snacks', product: 'Chips', quantity: 5, revenue: 100 },
  ]
  const summary = summarizeByCategory(productSummary)
  assert.deepEqual(summary, [
    { category: 'Beverages', quantity: 4, revenue: 195 },
    { category: 'Snacks', quantity: 5, revenue: 100 },
  ])
})

test('filterReceiptsByProductCategory keeps only receipts containing the selected product', () => {
  const receipts = [
    { id: 'r1', items: [{ name: 'Coke 1L', category: 'Beverages' }] },
    { id: 'r2', items: [{ name: 'Chips', category: 'Snacks' }] },
  ]
  const result = filterReceiptsByProductCategory(receipts, { productFilter: 'Coke 1L' })
  assert.deepEqual(result.map((r) => r.id), ['r1'])
})

test('filterReceiptsByProductCategory keeps only receipts containing the selected category', () => {
  const receipts = [
    { id: 'r1', items: [{ name: 'Coke 1L', category: 'Beverages' }] },
    { id: 'r2', items: [{ name: 'Chips', category: 'Snacks' }] },
  ]
  const result = filterReceiptsByProductCategory(receipts, { categoryFilter: 'Snacks' })
  assert.deepEqual(result.map((r) => r.id), ['r2'])
})

test('filterReceiptsByProductCategory returns everything when filters are "all"', () => {
  const receipts = [{ id: 'r1', items: [] }, { id: 'r2', items: [] }]
  const result = filterReceiptsByProductCategory(receipts, { productFilter: 'all', categoryFilter: 'all' })
  assert.equal(result.length, 2)
})
