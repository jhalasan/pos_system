import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { buildSalesMetrics, refundedUnitsBySaleAndProduct } = await import('../server/index.js')

// M1: refunds/exchanges net out of units-sold/FSN analytics, not just
// revenue -- a locked-in decision (POS_AUDIT_REGISTER.md). These tests
// exercise the pure aggregation helpers directly, without a live PocketBase.

function product(id, overrides = {}) {
  return { id, name: id, category: 'General', qty: 0, ...overrides }
}

function sale(id, overrides = {}) {
  return { id, status: 'completed', total_amount: 0, created_at: '2026-08-01T10:00:00Z', ...overrides }
}

function saleItem(saleId, productId, quantitySold, overrides = {}) {
  return { sale_id: saleId, product_id: productId, quantity_sold: quantitySold, ...overrides }
}

function adjustment(saleId, items, overrides = {}) {
  return { sale_id: saleId, items, ...overrides }
}

test('refundedUnitsBySaleAndProduct sums quantities per (sale, product)', () => {
  const adjustments = [
    adjustment('sale1', [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }]),
    adjustment('sale1', [{ productId: 'p1', quantity: 3 }]),
    adjustment('sale2', [{ productId: 'p1', quantity: 5 }]),
  ]
  const map = refundedUnitsBySaleAndProduct(adjustments)
  assert.equal(map.get('sale1:p1'), 5)
  assert.equal(map.get('sale1:p2'), 1)
  assert.equal(map.get('sale2:p1'), 5)
})

test('refundedUnitsBySaleAndProduct ignores malformed entries', () => {
  const map = refundedUnitsBySaleAndProduct([
    adjustment('', [{ productId: 'p1', quantity: 2 }]),
    adjustment('sale1', null),
    adjustment('sale1', [{ productId: '', quantity: 2 }]),
  ])
  assert.equal(map.size, 0)
})

test('buildSalesMetrics: a legacy sale with no adjustments reports full units unchanged', () => {
  const products = [product('p1')]
  const sales = [sale('sale1', { total_amount: 100 })]
  const saleItems = [saleItem('sale1', 'p1', 4)]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, [], now)
  assert.equal(metrics.get('p1').totalUnits, 4)
  assert.equal(metrics.get('p1').units90, 4)
})

test('buildSalesMetrics: a partial refund nets out of totalUnits and units90', () => {
  const products = [product('p1')]
  const sales = [sale('sale1', { total_amount: 100 })]
  const saleItems = [saleItem('sale1', 'p1', 10)]
  const adjustments = [adjustment('sale1', [{ productId: 'p1', quantity: 3 }])]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, adjustments, now)
  assert.equal(metrics.get('p1').totalUnits, 7)
  assert.equal(metrics.get('p1').units90, 7)
})

test('buildSalesMetrics: a refund exceeding recorded units clamps at zero, never negative', () => {
  const products = [product('p1')]
  const sales = [sale('sale1', { total_amount: 100 })]
  const saleItems = [saleItem('sale1', 'p1', 2)]
  const adjustments = [adjustment('sale1', [{ productId: 'p1', quantity: 99 }])]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, adjustments, now)
  assert.equal(metrics.get('p1').totalUnits, 0)
  assert.equal(metrics.get('p1').units90, 0)
})

test('buildSalesMetrics: a fully refunded sale does not count toward lastSoldAt', () => {
  const products = [product('p1')]
  const sales = [
    sale('sale1', { total_amount: 100, created_at: '2026-08-01T10:00:00Z' }),
    sale('sale2', { total_amount: 100, created_at: '2026-07-01T10:00:00Z' }),
  ]
  const saleItems = [saleItem('sale1', 'p1', 5), saleItem('sale2', 'p1', 5)]
  const adjustments = [adjustment('sale1', [{ productId: 'p1', quantity: 5 }])]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, adjustments, now)
  assert.equal(metrics.get('p1').lastSoldAt.toISOString(), new Date('2026-07-01T10:00:00Z').toISOString())
})

test('buildSalesMetrics: refunds do not cross-contaminate other products or other sales of the same product', () => {
  const products = [product('p1'), product('p2')]
  const sales = [sale('sale1', { total_amount: 100 }), sale('sale2', { total_amount: 50 })]
  const saleItems = [
    saleItem('sale1', 'p1', 10),
    saleItem('sale1', 'p2', 4),
    saleItem('sale2', 'p1', 6),
  ]
  const adjustments = [adjustment('sale1', [{ productId: 'p1', quantity: 3 }])]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, adjustments, now)
  assert.equal(metrics.get('p1').totalUnits, 13) // 10-3 (sale1) + 6 (sale2)
  assert.equal(metrics.get('p2').totalUnits, 4)
})

test('buildSalesMetrics: voided sales are excluded entirely, refund or not', () => {
  const products = [product('p1')]
  const sales = [sale('sale1', { total_amount: 100, status: 'voided' })]
  const saleItems = [saleItem('sale1', 'p1', 10)]
  const now = new Date('2026-08-15T00:00:00Z')

  const metrics = buildSalesMetrics(products, sales, saleItems, [], now)
  assert.equal(metrics.get('p1').totalUnits, 0)
})
