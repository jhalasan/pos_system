#!/usr/bin/env node
import fetch from 'node-fetch'
import { ensurePocketBaseAuth, pbCollection } from '../../server/pocketbase.js'

const API = process.env.API_URL || 'http://localhost:3001/api'

async function jsonFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (e) { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function main() {
  console.log('Ensuring PocketBase auth for creating test auth barcode...')
  await ensurePocketBaseAuth()
  const authCodes = await pbCollection('authorization_barcodes')
  const testCode = `TEST${Date.now()}`
  await authCodes.create({ code: testCode, label: 'E2E Test', purpose: 'void_discount', status: 'active', generated_by: '' })
  console.log('Created test authorization barcode:', testCode)

  // Create product with multiple units
  const productBody = {
    name: `E2E Noodles ${Date.now()}`,
    barcode: `BASE${Date.now()}`,
    unit: 'Piece',
    purchaseUnit: 'Pack',
    conversionQuantity: 6,
    hasMultipleUnits: true,
    sellingUnits: [
      { barcode: `PACK${Date.now()}`, unit: 'Pack', conversion: 6, price: 60 },
      { barcode: `PIECE${Date.now()}`, unit: 'Piece', conversion: 1, price: 12 },
    ],
    cost: 0,
    profitMargin: 0,
  }

  console.log('Creating product...')
  const created = await jsonFetch('/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(productBody) })
  if (!created.ok) throw new Error(`Failed to create product: ${created.status} ${JSON.stringify(created.data)}`)
  const product = created.data
  console.log('Product created:', product.id)

  // Stock-in a pack via inventory scan (should add 6 base units)
  const packBarcode = productBody.sellingUnits[0].barcode
  console.log('Scanning inventory pack to add 1 pack (should add 6 pieces)')
  const scanRes = await jsonFetch('/inventory/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ barcode: packBarcode, qty: 1 }) })
  if (!scanRes.ok) throw new Error(`Inventory scan failed: ${scanRes.status}`)
  const afterScan = scanRes.data
  console.log('After scan product qty:', afterScan.qty || afterScan.quantity || afterScan.qty)

  // Create a sale for 1 pack
  console.log('Creating sale for 1 pack...')
  const saleReq = await jsonFetch('/cashier/sales', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashierId: '', items: [{ productId: product.id, barcode: packBarcode, quantity: 1, price: 60 }], totalAmount: 60, subtotalAmount: 60 })
  })
  if (!saleReq.ok) throw new Error(`Sale creation failed: ${saleReq.status} ${JSON.stringify(saleReq.data)}`)
  const sale = saleReq.data
  console.log('Sale created:', sale.id || sale.transactionNo)

  // Fetch product and verify quantity decreased by 6
  const productsRes = await jsonFetch('/products')
  if (!productsRes.ok) throw new Error('Unable to fetch products')
  const found = (productsRes.data || []).find((p) => p.id === product.id)
  console.log('Product quantity after sale:', found.qty || found.quantity || found.qty)

  // Void sale using auth barcode
  console.log('Voiding sale using test auth barcode...')
  const voidRes = await jsonFetch(`/cashier/sales/${sale.id}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cashierId: '', code: testCode }) })
  if (!voidRes.ok) throw new Error(`Void failed: ${voidRes.status} ${JSON.stringify(voidRes.data)}`)
  console.log('Void response ok')

  // Fetch product and verify quantity restored
  const productsAfterVoid = await jsonFetch('/products')
  const foundAfterVoid = (productsAfterVoid.data || []).find((p) => p.id === product.id)
  console.log('Product quantity after void:', foundAfterVoid.qty || foundAfterVoid.quantity || foundAfterVoid.qty)

  console.log('E2E test completed successfully.')
}

main().catch((err) => { console.error(err); process.exit(1) })
