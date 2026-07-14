#!/usr/bin/env node
import assert from 'node:assert/strict'
import { ensurePocketBaseAuth, pb, pbCollection } from '../../server/pocketbase.js'

const API = process.env.API_URL || 'http://localhost:3001/api'

async function jsonFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function deleteMatching(collectionName, filter) {
  const collection = await pbCollection(collectionName)
  const records = await collection.getFullList({ filter, requestKey: null }).catch(() => [])
  await Promise.all(records.map((record) => collection.delete(record.id, { requestKey: null }).catch(() => {})))
}

async function main() {
  if (process.env.E2E_ALLOW_MUTATION !== 'true') {
    throw new Error('E2E tests create temporary records. Set E2E_ALLOW_MUTATION=true and use a dedicated test PocketBase instance.')
  }

  await ensurePocketBaseAuth()
  const runId = Date.now()
  const productName = `E2E Noodles ${runId}`
  const testCode = `TEST${runId}`
  let authorizationId = ''
  let productId = ''
  let saleId = ''
  let transactionNo = ''

  try {
    const cashier = await (await pbCollection('users')).getFirstListItem(
      pb.filter('role = {:role} && status = {:status}', { role: 'cashier', status: 'active' }),
      { requestKey: null },
    )

    const authorization = await (await pbCollection('authorization_barcodes')).create({
      code: testCode,
      label: `E2E Test ${runId}`,
      purpose: 'void_discount',
      status: 'active',
      generated_by: '',
    }, { requestKey: null })
    authorizationId = authorization.id

    const productBody = {
      name: productName,
      barcode: `BASE${runId}`,
      unit: 'Piece',
      purchaseUnit: 'Pack',
      conversionQuantity: 6,
      hasMultipleUnits: true,
      sellingUnits: [
        { barcode: `PACK${runId}`, unit: 'Pack', conversion: 6, price: 60 },
        { barcode: `PIECE${runId}`, unit: 'Piece', conversion: 1, price: 12 },
      ],
      price: 12,
      cost: 0,
      profitMargin: 0,
    }

    const created = await jsonFetch('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productBody),
    })
    assert.equal(created.ok, true, `Product creation failed: ${created.status} ${JSON.stringify(created.data)}`)
    productId = created.data.id

    const scan = await jsonFetch('/inventory/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: productBody.sellingUnits[0].barcode, qty: 1 }),
    })
    assert.equal(scan.ok, true, `Inventory scan failed: ${scan.status} ${JSON.stringify(scan.data)}`)
    assert.equal(Number(scan.data.qty ?? scan.data.quantity), 6, 'One pack should add six base units.')

    const saleResult = await jsonFetch('/cashier/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cashierId: cashier.id,
        items: [{ productId, barcode: productBody.sellingUnits[0].barcode, quantity: 1, price: 60 }],
        totalAmount: 60,
        subtotalAmount: 60,
      }),
    })
    assert.equal(saleResult.ok, true, `Sale creation failed: ${saleResult.status} ${JSON.stringify(saleResult.data)}`)
    saleId = saleResult.data.id
    transactionNo = saleResult.data.transactionNo

    let products = await jsonFetch('/products')
    assert.equal(products.ok, true, 'Unable to fetch products after the sale.')
    assert.equal(Number(products.data.find((item) => item.id === productId)?.qty), 0, 'Selling one pack should deduct six base units.')

    const voidResult = await jsonFetch(`/cashier/sales/${saleId}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashierId: cashier.id, code: testCode, reason: `E2E cleanup ${runId}` }),
    })
    assert.equal(voidResult.ok, true, `Void failed: ${voidResult.status} ${JSON.stringify(voidResult.data)}`)

    products = await jsonFetch('/products')
    assert.equal(products.ok, true, 'Unable to fetch products after the void.')
    assert.equal(Number(products.data.find((item) => item.id === productId)?.qty), 6, 'Voiding the sale should restore six base units.')
    console.log('E2E sale, stock conversion, and void checks passed.')
  } finally {
    if (saleId) {
      await deleteMatching('stock_movements', pb.filter('reference_id = {:id}', { id: saleId }))
      await deleteMatching('sale_items', pb.filter('sale_id = {:id}', { id: saleId }))
      await (await pbCollection('sales')).delete(saleId, { requestKey: null }).catch(() => {})
    }
    if (productId) await (await pbCollection('products')).delete(productId, { requestKey: null }).catch(() => {})
    if (authorizationId) await (await pbCollection('authorization_barcodes')).delete(authorizationId, { requestKey: null }).catch(() => {})
    await deleteMatching('activity_logs', pb.filter(
      'description ~ {:product} || description ~ {:transaction}',
      { product: productName, transaction: transactionNo || `E2E-${runId}` },
    ))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
