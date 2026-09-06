// One-time reconciliation: copies everything PocketHost recorded after the
// local server's backup-snapshot cutoff (sales made by POS-72F1F2, which
// kept writing to PocketHost while POS-25A2EE moved to the local server)
// into the local PocketBase, so the local database catches up to reality
// before it's treated as the single source of truth.
//
// Deliberately does NOT try to replay each sale's exact stock deduction by
// guessing unit-conversion factors (that information isn't preserved on a
// stored sale_items row -- see stockMovementReconciler.js's own comments on
// why replay-by-movement-chain is unsafe across two databases that diverged
// at the snapshot). Instead: sales/sale_items/stock_movements are copied
// as-is for an accurate audit trail, and each affected product's quantity is
// corrected by applying the *net delta* of PocketHost's post-cutoff
// stock_movements directly on top of the local server's CURRENT quantity
// (which already correctly reflects the snapshot minus whatever
// POS-25A2EE sold locally) -- not by re-deriving a blended baseline from a
// merged movement history, which would double-count or miscount whenever
// the two databases' absolute quantity tracks diverged after the snapshot.
//
// Usage:
//   node scripts/reconcile-pockethost-to-local.mjs               # dry run
//   node scripts/reconcile-pockethost-to-local.mjs --apply       # writes
//   node scripts/reconcile-pockethost-to-local.mjs --since=2026-09-05T12:52:00.000Z
//
// Env:
//   RECONCILE_SOURCE_URL (default: POCKETBASE_URL, i.e. PocketHost)
//   RECONCILE_TARGET_URL (required: the local server, e.g. http://192.168.0.114:8090)
//   POCKETBASE_SUPERUSER_EMAIL / POCKETBASE_SUPERUSER_PASSWORD (used for both)

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import PocketBase from 'pocketbase'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const sinceArg = [...args].find((arg) => arg.startsWith('--since='))
const reportDir = path.resolve('migration_reports')

const SOURCE_URL = process.env.RECONCILE_SOURCE_URL || process.env.POCKETBASE_URL
const TARGET_URL = process.env.RECONCILE_TARGET_URL

if (!SOURCE_URL) throw new Error('RECONCILE_SOURCE_URL or POCKETBASE_URL (PocketHost) is required.')
if (!TARGET_URL) throw new Error('RECONCILE_TARGET_URL (the local server, e.g. http://192.168.0.114:8090) is required.')

const STOCK_INCREASE_TYPES = ['stock_in', 'void_return', 'refund_return', 'exchange_return']

function movementDelta(movement) {
  const previous = Number(movement.previous_quantity)
  const next = Number(movement.new_quantity)
  if (Number.isFinite(previous) && Number.isFinite(next)) return next - previous
  const qty = Math.abs(Number(movement.quantity) || 0)
  return STOCK_INCREASE_TYPES.includes(movement.movement_type) ? qty : -qty
}

async function auth(pb) {
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD
  if (!email || !password) throw new Error('PocketBase superuser credentials are missing (POCKETBASE_SUPERUSER_EMAIL/PASSWORD).')
  try {
    await pb.collection('_superusers').authWithPassword(email, password)
  } catch (error) {
    if (error.status !== 404) throw error
    await pb.collection('_admins').authWithPassword(email, password)
  }
}

async function findExistingIds(pb, collection, ids) {
  const found = new Set()
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40)
    if (!chunk.length) continue
    const filter = chunk.map((id) => pb.filter('id = {:id}', { id })).join(' || ')
    const rows = await pb.collection(collection).getFullList({ filter, fields: 'id', requestKey: null })
    for (const row of rows) found.add(row.id)
  }
  return found
}

async function fetchByField(pb, collection, field, values, extraOptions = {}) {
  const rows = []
  const unique = [...new Set(values.filter(Boolean))]
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40)
    const filter = chunk.map((value) => pb.filter(`${field} = {:value}`, { value })).join(' || ')
    const found = await pb.collection(collection).getFullList({ filter, requestKey: null, ...extraOptions })
    rows.push(...found)
  }
  return rows
}

async function main() {
  const source = new PocketBase(SOURCE_URL)
  source.autoCancellation(false)
  const target = new PocketBase(TARGET_URL)
  target.autoCancellation(false)
  await Promise.all([auth(source), auth(target)])

  let cutoff = sinceArg ? sinceArg.split('=').slice(1).join('=') : null
  if (!cutoff) {
    const latest = await target.collection('sales').getList(1, 1, {
      sort: '-created_at',
      fields: 'created_at',
      requestKey: null,
    }).catch(() => null)
    cutoff = latest?.items?.[0]?.created_at || '1970-01-01 00:00:00.000Z'
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    source: SOURCE_URL,
    target: TARGET_URL,
    cutoff,
    counts: {},
    productAdjustments: [],
    warnings: [],
  }

  // ---- 1. Sales created on PocketHost after the cutoff ----
  const salesFilter = source.filter('created_at > {:cutoff}', { cutoff })
  const sourceSales = await source.collection('sales').getFullList({ filter: salesFilter, sort: 'created_at', requestKey: null })
  const existingSaleIds = await findExistingIds(target, 'sales', sourceSales.map((s) => s.id))
  const missingSales = sourceSales.filter((s) => !existingSaleIds.has(s.id))
  report.counts.sourceSalesAfterCutoff = sourceSales.length
  report.counts.missingSales = missingSales.length

  // ---- 2. sale_items belonging to those missing sales ----
  const missingSaleIds = missingSales.map((s) => s.id)
  const sourceSaleItems = missingSaleIds.length
    ? await fetchByField(source, 'sale_items', 'sale_id', missingSaleIds)
    : []
  report.counts.missingSaleItems = sourceSaleItems.length

  // ---- 3. Products referenced by those sale_items -- copy over any that ----
  //         only exist on PocketHost (created after the snapshot there too).
  const referencedProductIds = [...new Set(sourceSaleItems.map((item) => (
    Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
  )).filter(Boolean))]
  const existingProductIds = await findExistingIds(target, 'products', referencedProductIds)
  const missingProductIds = referencedProductIds.filter((id) => !existingProductIds.has(id))
  const missingProducts = missingProductIds.length
    ? await source.collection('products').getFullList({
        filter: missingProductIds.map((id) => source.filter('id = {:id}', { id })).join(' || '),
        requestKey: null,
      })
    : []
  report.counts.missingProducts = missingProducts.length
  if (missingProducts.length) {
    report.warnings.push(`${missingProducts.length} product(s) referenced by reconciled sales do not exist locally yet and will be copied: ${missingProducts.map((p) => p.name || p.id).join(', ')}`)
  }

  // ---- 4. cashiers (users) referenced by missing sales ----
  const referencedCashierIds = [...new Set(missingSales.map((s) => (
    Array.isArray(s.cashier_id) ? s.cashier_id[0] : s.cashier_id
  )).filter(Boolean))]
  const existingUserIds = await findExistingIds(target, 'users', referencedCashierIds)
  const missingCashierIds = referencedCashierIds.filter((id) => !existingUserIds.has(id))
  if (missingCashierIds.length) {
    report.warnings.push(`${missingCashierIds.length} cashier account(s) referenced by reconciled sales do not exist locally: ${missingCashierIds.join(', ')} -- those sales will be skipped.`)
  }
  const skippedSaleIds = new Set(
    missingSales.filter((s) => missingCashierIds.includes(Array.isArray(s.cashier_id) ? s.cashier_id[0] : s.cashier_id)).map((s) => s.id),
  )
  const applicableSales = missingSales.filter((s) => !skippedSaleIds.has(s.id))
  const applicableSaleItems = sourceSaleItems.filter((item) => !skippedSaleIds.has(item.sale_id))
  report.counts.skippedSalesMissingCashier = skippedSaleIds.size

  // ---- 5. stock_movements created after the cutoff (all types) ----
  const movementsFilter = source.filter('created_at > {:cutoff}', { cutoff })
  const sourceMovements = await source.collection('stock_movements').getFullList({ filter: movementsFilter, sort: 'created_at', requestKey: null })
  const existingMovementIds = await findExistingIds(target, 'stock_movements', sourceMovements.map((m) => m.id))
  const missingMovements = sourceMovements.filter((m) => !existingMovementIds.has(m.id))
  report.counts.sourceMovementsAfterCutoff = sourceMovements.length
  report.counts.missingMovements = missingMovements.length

  // ---- 6. Net per-product delta from those movements (the actual fix) ----
  const deltaByProduct = new Map()
  for (const movement of missingMovements) {
    const productId = Array.isArray(movement.product_id) ? movement.product_id[0] : movement.product_id
    if (!productId) continue
    deltaByProduct.set(productId, (deltaByProduct.get(productId) || 0) + movementDelta(movement))
  }
  for (const [productId, delta] of deltaByProduct) {
    if (delta !== 0) report.productAdjustments.push({ productId, netDelta: delta })
  }
  report.counts.productsToAdjust = report.productAdjustments.filter((row) => row.netDelta !== 0).length

  // ---- 7. cash_movements / activity_logs / sale_adjustments after cutoff ----
  // activity_logs uses its own `timestamp` field (see uploadActivityLog /
  // uploadSale in cashier-pos/offline/syncEngine.js) -- every other
  // collection here uses `created_at`.
  const dateFieldByCollection = { cash_movements: 'created_at', activity_logs: 'timestamp', sale_adjustments: 'created_at' }
  for (const collection of ['cash_movements', 'activity_logs', 'sale_adjustments']) {
    const dateField = dateFieldByCollection[collection]
    const rows = await source.collection(collection).getFullList({
      filter: source.filter(`${dateField} > {:cutoff}`, { cutoff }),
      requestKey: null,
    }).catch((error) => { report.warnings.push(`Failed to read source ${collection}: ${error.message || error}`); return [] })
    const existingIds = await findExistingIds(target, collection, rows.map((r) => r.id))
    const missing = rows.filter((r) => !existingIds.has(r.id))
    report.counts[`missing_${collection}`] = missing.length
    report[`_${collection}`] = missing
  }

  if (!apply) {
    fs.mkdirSync(reportDir, { recursive: true })
    const reportPath = path.join(reportDir, 'reconciliation-dry-run.json')
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
    console.log(`\nDRY RUN -- no data was written. Report saved to ${reportPath}.`)
    console.log('Re-run with --apply once you have reviewed the counts above.')
    return
  }

  // ==== APPLY ====
  const idempotencyReport = { createdSales: 0, createdSaleItems: 0, createdMovements: 0, createdProducts: 0, adjustedProducts: 0, skippedExisting: 0 }

  for (const product of missingProducts) {
    await target.collection('products').create(product, { requestKey: null }).catch((error) => {
      if (error?.status === 400) { idempotencyReport.skippedExisting += 1; return }
      throw error
    })
    idempotencyReport.createdProducts += 1
  }

  for (const sale of applicableSales) {
    await target.collection('sales').create(sale, { requestKey: null }).catch((error) => {
      if (error?.status === 400) { idempotencyReport.skippedExisting += 1; return }
      throw error
    })
    idempotencyReport.createdSales += 1
  }

  for (const item of applicableSaleItems) {
    await target.collection('sale_items').create(item, { requestKey: null }).catch((error) => {
      if (error?.status === 400) { idempotencyReport.skippedExisting += 1; return }
      throw error
    })
    idempotencyReport.createdSaleItems += 1
  }

  for (const movement of missingMovements) {
    await target.collection('stock_movements').create(movement, { requestKey: null }).catch((error) => {
      if (error?.status === 400) { idempotencyReport.skippedExisting += 1; return }
      throw error
    })
    idempotencyReport.createdMovements += 1
  }

  for (const collection of ['cash_movements', 'activity_logs', 'sale_adjustments']) {
    for (const row of report[`_${collection}`] || []) {
      await target.collection(collection).create(row, { requestKey: null }).catch((error) => {
        if (error?.status === 400) { idempotencyReport.skippedExisting += 1; return }
        throw error
      })
    }
  }

  // ---- Apply the net stock correction, once per product, idempotently ----
  const cutoffSlug = cutoff.replace(/[^0-9]/g, '')
  for (const { productId, netDelta } of report.productAdjustments) {
    if (netDelta === 0) continue
    const referenceId = `reconcile:pockethost-merge:${cutoffSlug}:${productId}`
    const already = await target.collection('stock_movements').getFirstListItem(
      target.filter('reference_id = {:referenceId}', { referenceId }),
      { requestKey: null },
    ).catch(() => null)
    if (already) { idempotencyReport.skippedExisting += 1; continue }

    const product = await target.collection('products').getOne(productId, { requestKey: null })
    const previousQuantity = Number(product.quantity) || 0
    const nextQuantity = Math.max(0, previousQuantity + netDelta)
    await target.collection('products').update(productId, { quantity: String(nextQuantity) }, { requestKey: null })
    await target.collection('stock_movements').create({
      product_id: productId,
      movement_type: 'adjustment',
      quantity: Math.abs(nextQuantity - previousQuantity),
      previous_quantity: previousQuantity,
      new_quantity: nextQuantity,
      reference_type: 'reconciliation',
      reference_id: referenceId,
      notes: `PocketHost -> local reconciliation merge for sales after ${cutoff}.`,
      created_at: new Date().toISOString(),
    }, { requestKey: null })
    idempotencyReport.adjustedProducts += 1
  }

  report.applied = idempotencyReport
  report.completedAt = new Date().toISOString()
  fs.mkdirSync(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, 'reconciliation-result.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.log(`\nReconciliation applied. Report saved to ${reportPath}.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
