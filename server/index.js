import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import {
  authenticateAdminUser,
  authenticateAdminToken,
  authenticateRoleUser,
  pb,
  pbCollection,
  PB_URL,
} from './pocketbase.js'
import {
  activityLogPayload,
  cashierFormData,
  deriveStatus,
  productPayload,
  productFormData,
  toActivityLog,
  toCashier,
  toProduct,
  toUserAccount,
} from './formatters.js'

const app = express()
const PORT = Number(process.env.PORT || process.env.API_PORT || 3001)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, '..', 'dist')
const INDEX_HTML = path.join(DIST_DIR, 'index.html')
const PB_PROXY_TARGET = process.env.POCKETBASE_PROXY_TARGET || PB_URL
const AUTO_BACKUP_ENABLED = String(process.env.AUTO_BACKUP_ENABLED || 'true').toLowerCase() !== 'false'
const AUTO_BACKUP_RETENTION = Math.max(1, Number(process.env.AUTO_BACKUP_RETENTION) || 7)
const AUTO_BACKUP_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.AUTO_BACKUP_INTERVAL_MS) || 24 * 60 * 60 * 1000)
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:1420,http://localhost:5133,http://localhost:5173,http://localhost:5174')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const ngrokHostPattern = /^https:\/\/[a-z0-9-]+\.ngrok-free\.dev$/i
const ngrokAppPattern = /^https:\/\/[a-z0-9-]+\.ngrok-free\.app$/i
const localNetworkHostPattern = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})$/i
const isVercelAdminPortal = Boolean(process.env.VERCEL || process.env.ADMIN_WEB_ONLY === 'true')
const allowDevelopmentOrigins = process.env.NODE_ENV !== 'production' && !isVercelAdminPortal

function parseOrigin(origin) {
  try {
    return origin ? new URL(origin) : null
  } catch {
    return null
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(new Error('Product image must be a JPEG, PNG, or WEBP file.'))
      return
    }
    cb(null, true)
  },
})

app.use(cors({
  origin(origin, callback) {
    const parsedOrigin = parseOrigin(origin)
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      (allowDevelopmentOrigins && ngrokHostPattern.test(origin)) ||
      (allowDevelopmentOrigins && ngrokAppPattern.test(origin)) ||
      (allowDevelopmentOrigins && parsedOrigin && ['http:', 'https:'].includes(parsedOrigin.protocol) && localNetworkHostPattern.test(parsedOrigin.hostname))
    ) {
      callback(null, true)
      return
    }
    callback(new Error(`Origin ${origin} is not allowed by CORS.`))
  },
  credentials: true,
  exposedHeaders: ['Authorization', 'Location', 'X-PocketBase-Token'],
}))

if (!isVercelAdminPortal) app.use('/api/pocketbase', createProxyMiddleware({
  target: PB_PROXY_TARGET,
  changeOrigin: true,
  pathRewrite: (path) => `/api${path}`,
  xfwd: true,
  on: {
    proxyReq(proxyReq) {
      proxyReq.setHeader('ngrok-skip-browser-warning', 'true')
    },
    proxyRes(proxyRes) {
      delete proxyRes.headers['x-frame-options']
    },
    error(err, _req, res) {
      console.error(`PocketBase proxy error: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: `PocketBase proxy failed. Make sure PocketBase is reachable at ${PB_PROXY_TARGET}.` }))
    },
  },
}))

app.use(express.json())

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

async function listRecords(collection, query = '') {
  const params = Object.fromEntries(new URLSearchParams(query.replace(/^\?/, '')))
  return (await pbCollection(collection)).getFullList({
    sort: params.sort,
    filter: params.filter,
    expand: params.expand,
  })
}

async function getOrCreateCategoryId(categoryName) {
  const name = String(categoryName || '').trim()
  if (!name) return ''

  const categories = await pbCollection('categories')
  const existing = await categories.getFirstListItem(
    pb.filter('name = {:name}', { name }),
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (existing) return existing.id

  const created = await categories.create({ name })
  return created.id
}

async function getSalesByCashier() {
  const totals = new Map()
  const sales = await listRecords('sales', '?filter=status!="voided"&perPage=500')

  for (const sale of sales) {
    const cashierId = Array.isArray(sale.cashier_id) ? sale.cashier_id[0] : sale.cashier_id
    if (!cashierId) continue
    totals.set(cashierId, (totals.get(cashierId) || 0) + (Number(sale.total_amount) || 0))
  }

  return totals
}

function gcashPaymentFromSale(sale) {
  let paymentMethod = sale.payment_method || ''
  let refNumber = sale.ref_number || ''
  let splitPayments = null

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }
  if (!paymentMethod && refNumber) paymentMethod = 'gcash'

  const totalAmount = Number(sale.total_amount) || 0
  const splitGcash = Number(splitPayments?.gcash) || 0
  const amount = paymentMethod === 'split' ? splitGcash : totalAmount
  if (paymentMethod !== 'gcash' && splitGcash <= 0) return null

  const cashier = Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id

  return {
    id: sale.id,
    transactionNo: sale.transaction_no || sale.id,
    createdAt: sale.created_at || sale.created,
    cashierName: cashier?.name || cashier?.email || String(sale.cashier_id || ''),
    paymentType: paymentMethod === 'split' ? 'Split' : 'GCash',
    amount,
    totalAmount,
    cashAmount: paymentMethod === 'split' ? Number(splitPayments?.cash) || 0 : 0,
    referenceNumber: paymentMethod === 'split' ? String(splitPayments?.gcashRef || '') : refNumber,
    status: sale.status || 'completed',
  }
}

function saleCashier(sale) {
  return Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id
}

function parseSalePayment(sale) {
  let paymentMethod = sale.payment_method || sale.paymentMethod || 'cash'
  let refNumber = sale.ref_number || sale.refNumber || ''
  let splitPayments = null

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }
  if ((!paymentMethod || paymentMethod === 'cash') && refNumber && !String(refNumber).startsWith('split:')) {
    paymentMethod = 'gcash'
  }
  if (!paymentMethod) paymentMethod = 'cash'

  return { paymentMethod, refNumber, splitPayments }
}

function saleItemQuantity(item) {
  return Number(item.quantity_sold ?? item.quantity ?? item.qty) || 0
}

function saleItemPrice(item, product) {
  return Number(item.price_at_sale ?? item.price ?? item.unit_price ?? product?.price) || 0
}

async function receiptRecordFromSale(sale, saleItemsCollection) {
  const cashier = saleCashier(sale)
  const items = await saleItemsCollection.getFullList({
    sort: 'created',
    filter: pb.filter('sale_id = {:saleId}', { saleId: sale.id }),
    expand: 'product_id',
  })
  const { paymentMethod, refNumber, splitPayments } = parseSalePayment(sale)
  const status = sale.status || 'completed'
  const createdAt = sale.created_at || sale.created

  return {
    id: sale.id,
    saleId: sale.id,
    transactionNo: sale.transaction_no || sale.id,
    receiptNo: sale.transaction_no || sale.id,
    createdAt,
    cashierId: productRelationId(sale.cashier_id) || '',
    cashierName: cashier?.name || cashier?.email || String(sale.cashier_id || ''),
    totalAmount: Number(sale.total_amount) || 0,
    subtotalAmount: Number(sale.total_amount) || 0,
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod,
    refNumber,
    splitPayments,
    cashAmount: paymentMethod === 'cash' ? Number(sale.total_amount) || 0 : 0,
    gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount) || 0 : 0,
    status: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Completed',
    rawStatus: status,
    actionStatus: status === 'voided' ? 'Voided' : status === 'adjusted' ? 'Adjusted' : 'Reprint available',
    itemCount: items.length ? items.reduce((sum, item) => sum + saleItemQuantity(item), 0) : null,
    missingItems: items.length === 0,
    items: items.map((item) => {
      const product = Array.isArray(item.expand?.product_id)
        ? item.expand.product_id[0]
        : item.expand?.product_id
      const matchingUnitBarcode = item.matching_unit_barcode || ''
      const baseQuantity = Number(item.base_quantity_sold) || null
      return {
        productId: productRelationId(item.product_id) || item.id,
        id: item.id,
        name: product?.name || item.product_id || 'Product',
        barcode: item.barcode || product?.barcode || '',
        matchingUnitBarcode,
        baseQuantity,
        quantity: saleItemQuantity(item),
        price: saleItemPrice(item, product),
      }
    }),
  }
}

async function createLog(log) {
  try {
    await (await pbCollection('activity_logs')).create(activityLogPayload(log))
  } catch (error) {
    console.warn(`Could not write activity log: ${error.message}`)
  }
}

async function createStockMovement(payload) {
  try {
    await (await pbCollection('stock_movements')).create({
      product_id: payload.productId,
      movement_type: payload.movementType,
      quantity: Number(payload.quantity) || 0,
      previous_quantity: Number(payload.previousQuantity) || 0,
      new_quantity: Number(payload.newQuantity) || 0,
      reference_type: payload.referenceType || '',
      reference_id: payload.referenceId || '',
      notes: payload.notes || '',
      user_id: payload.userId || '',
      created_at: payload.createdAt || new Date().toISOString(),
    })
  } catch (error) {
    console.warn(`Could not write stock movement: ${error.message}`)
  }
}

async function authorizeManagerApproval({ code, email, password }) {
  const barcode = String(code || '').trim()
  if (barcode) {
    const authorization = await pbCollection('authorization_barcodes')
      .then((collection) => collection.getFirstListItem(
        pb.filter('code = {:code} && status = "active"', { code: barcode }),
        { expand: 'generated_by' },
      ))
      .catch((error) => {
        if (error.status === 404) return null
        throw error
      })

    if (authorization) {
      const generatedBy = Array.isArray(authorization.expand?.generated_by)
        ? authorization.expand.generated_by[0]
        : authorization.expand?.generated_by

      return {
        id: generatedBy?.id || '',
        name: generatedBy?.name || generatedBy?.email || 'Manager',
        email: generatedBy?.email || '',
        method: 'barcode',
      }
    }

    const legacyManager = await (await pbCollection('users')).getFirstListItem(
      pb.filter('void_barcode = {:code} && (role = "manager" || role = "admin" || role = "cashier") && status != "inactive"', { code: barcode }),
    ).catch((error) => {
      if (error.status === 404) return null
      throw error
    })

    if (legacyManager && (legacyManager.role !== 'cashier' || barcode.startsWith('92'))) {
      return {
        id: legacyManager.id,
        name: legacyManager.name || legacyManager.email || 'Manager',
        email: legacyManager.email || '',
        method: 'barcode',
      }
    }
  }

  const managerEmail = String(email || '').trim()
  const managerPassword = String(password || '')
  if (managerEmail && managerPassword) {
    const manager = await authenticateRoleUser(managerEmail, managerPassword, 'manager')
      .catch(async () => {
        const cashierManager = await authenticateRoleUser(managerEmail, managerPassword, 'cashier')
        if (!String(cashierManager?.void_barcode || '').startsWith('92')) throw new Error('Only manager accounts can approve cashier overrides.')
        return cashierManager
      })
      .catch(() => authenticateAdminUser(managerEmail, managerPassword))
    return {
      id: manager.id,
      name: manager.name || manager.email || 'Manager',
      email: manager.email || '',
      method: 'password',
    }
  }

  const error = new Error('Manager approval requires a valid barcode or manager email and password.')
  error.status = 400
  throw error
}

function productRecordPayload(body = {}, categoryId, file) {
  return file ? productFormData(body, categoryId, file) : productPayload(body, categoryId)
}

function productRequestBody(req) {
  return req.body || {}
}

async function nextTransactionNumber() {
  const now = new Date()
  const datePrefix = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')

  const sales = await pbCollection('sales')
  const records = await sales.getFullList({
    filter: pb.filter('transaction_no ~ {:prefix}', { prefix: datePrefix }),
    fields: 'transaction_no',
  }).catch((error) => {
    if (error.status === 400) {
      const setupError = new Error('PocketBase is missing the sales.transaction_no field. Import pocketbase/pb_schema.json before completing cashier transactions.')
      setupError.status = 500
      throw setupError
    }
    throw error
  })
  const maxSequence = records.reduce((max, record) => {
    const value = String(record.transaction_no || '')
    if (!value.startsWith(datePrefix)) return max

    const sequence = Number(value.slice(datePrefix.length))
    return Number.isFinite(sequence) ? Math.max(max, sequence) : max
  }, 0)
  const nextSequence = String(maxSequence + 1).padStart(4, '0')

  return `${datePrefix}${nextSequence}`
}

async function nextAuthorizationBarcode() {
  const authorizationBarcodes = await pbCollection('authorization_barcodes').catch((error) => {
    if (error.status === 404) {
      const setupError = new Error('PocketBase is missing the authorization_barcodes collection. Import pocketbase/pb_schema.json before generating authorization barcodes.')
      setupError.status = 500
      throw setupError
    }
    throw error
  })

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const barcode = `90${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
    const existing = await authorizationBarcodes.getFirstListItem(
      pb.filter('code = {:barcode}', { barcode }),
      { fields: 'id' },
    ).catch((error) => {
      if (error.status === 404) return null
      throw error
    })
    if (!existing) return barcode
  }

  const error = new Error('Could not generate a unique authorization barcode. Please try again.')
  error.status = 409
  throw error
}

async function nextProductBarcode() {
  const products = await pbCollection('products')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const barcode = `29${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 10)}`
    const existing = await products.getFirstListItem(
      pb.filter('barcode = {:barcode}', { barcode }),
      { fields: 'id' },
    ).catch((error) => {
      if (error.status === 404) return null
      throw error
    })
    if (!existing) return barcode
  }

  const error = new Error('Could not generate a unique product barcode. Please try again.')
  error.status = 409
  throw error
}

function saleDate(sale) {
  return new Date(sale.created_at || sale.created)
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function productRelationId(value) {
  return Array.isArray(value) ? value[0] : value
}

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, number) : 0)
}

function parseSellingUnits(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

async function findProductByScanBarcode(barcode) {
  const normalizedBarcode = String(barcode || '').trim()
  if (!normalizedBarcode) return null

  const records = await (await pbCollection('products')).getFullList({
    fields: 'id,barcode,name,quantity,selling_units,sellingUnits',
  }).catch(() => [])

  return records.find((record) => {
    if (String(record.barcode || '').trim() === normalizedBarcode) return true
    return parseSellingUnits(record.selling_units ?? record.sellingUnits)
      .some((unit) => String(unit?.barcode || '').trim() === normalizedBarcode)
  }) || null
}

function isCriticalStock(product) {
  const status = deriveStatus(product)
  return status === 'critical' || status === 'out-of-stock'
}

function productNameKey(value) {
  return String(value || '').trim().toLowerCase()
}

function expandedSaleItemProduct(item) {
  return Array.isArray(item.expand?.product_id)
    ? item.expand.product_id[0]
    : item.expand?.product_id
}

function buildProductLookup(products = []) {
  return {
    byId: new Map(products.map((product) => [String(product.id), product])),
    byBarcode: new Map(products.map((product) => [String(product.barcode || '').trim(), product]).filter(([barcode]) => barcode)),
    byName: new Map(products.map((product) => [productNameKey(product.name), product]).filter(([name]) => name)),
  }
}

function resolveSaleItemProduct(item, lookup) {
  const productId = productRelationId(item.product_id ?? item.productId)
  const expandedProduct = expandedSaleItemProduct(item)
  const barcode = String(item.barcode || expandedProduct?.barcode || '').trim()
  const name = productNameKey(item.name || expandedProduct?.name)

  return lookup.byId.get(String(productId || ''))
    || lookup.byBarcode.get(barcode)
    || lookup.byName.get(name)
    || null
}

function buildSalesMetrics(products, sales, saleItems, now = new Date()) {
  const salesById = new Map(sales.map((sale) => [sale.id, sale]))
  const completedSales = sales.filter((sale) => (sale.status || 'completed') !== 'voided')
  const completedSaleIds = new Set(completedSales.map((sale) => sale.id))
  const ninetyDaysAgo = new Date(now)
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const productLookup = buildProductLookup(products)

  const metricsByProduct = new Map(products.map((product) => [product.id, {
    units90: 0,
    totalUnits: 0,
    lastSoldAt: null,
  }]))

  for (const item of saleItems) {
    const saleId = productRelationId(item.sale_id)
    if (!completedSaleIds.has(saleId)) continue
    const sale = salesById.get(saleId)
    if (!sale) continue

    const soldAt = saleDate(sale)
    const product = resolveSaleItemProduct(item, productLookup)
    const productId = product?.id || productRelationId(item.product_id)
    if (!productId) continue

    const metric = metricsByProduct.get(productId) || { units90: 0, totalUnits: 0, lastSoldAt: null }
    const quantity = Number(item.quantity_sold) || 0
    metric.totalUnits += quantity
    if (soldAt >= ninetyDaysAgo) metric.units90 += quantity
    if (!metric.lastSoldAt || soldAt > metric.lastSoldAt) metric.lastSoldAt = soldAt
    metricsByProduct.set(productId, metric)
  }

  return metricsByProduct
}

function classifyFsnProduct(product, metric, now = new Date()) {
  const lastSoldAt = metric?.lastSoldAt || null
  const daysSinceLastSale = lastSoldAt
    ? Math.floor((now - lastSoldAt) / (1000 * 60 * 60 * 24))
    : null
  const units90 = Number(metric?.units90) || 0
  const averageMonthlyUnits = units90 / 3

  if (units90 >= 15 || (units90 >= 6 && daysSinceLastSale !== null && daysSinceLastSale <= 30)) {
    return {
      ...product,
      fsn: 'Fast-moving',
      fsnReason: `${units90} unit(s) sold in the last 90 days`,
      units90,
      averageMonthlyUnits,
      lastSoldAt,
      daysSinceLastSale,
    }
  }

  if (units90 > 0 && daysSinceLastSale !== null && daysSinceLastSale <= 90) {
    return {
      ...product,
      fsn: 'Slow-moving',
      fsnReason: `${units90} unit(s) sold in the last 90 days`,
      units90,
      averageMonthlyUnits,
      lastSoldAt,
      daysSinceLastSale,
    }
  }

  return {
    ...product,
    fsn: 'Non-moving',
    fsnReason: lastSoldAt ? `No sales in the last ${daysSinceLastSale} days` : 'No recorded sales yet',
    units90,
    averageMonthlyUnits,
    lastSoldAt,
    daysSinceLastSale,
  }
}

function lastMonths(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1)
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleString('en-US', { month: 'short' }),
      value: 0,
    }
  })
}

function lastDays(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (count - 1 - index))
    return {
      key: dateKey(date),
      label: date.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
      value: 0,
    }
  })
}

function weekStart(date) {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  return start
}

function weekKey(date) {
  return dateKey(weekStart(date))
}

function lastWeeks(count, now = new Date()) {
  const currentWeek = weekStart(now)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(currentWeek)
    date.setDate(date.getDate() - (7 * (count - 1 - index)))
    return {
      key: dateKey(date),
      label: date.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
      value: 0,
    }
  })
}

function lastYears(count, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const year = now.getFullYear() - (count - 1 - index)
    return {
      key: String(year),
      label: String(year),
      value: 0,
    }
  })
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pb.health.check()
  res.json({ ok: true })
}))

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const user = await authenticateAdminUser(email, password)
  await createLog({ userId: user.id, action: 'Login', detail: 'Signed in to admin dashboard' })
  const { token, ...safeUser } = user
  res.json({ ok: true, user: safeUser, token })
}))

app.use('/api/cashier', (req, res, next) => {
  if (!isVercelAdminPortal) {
    next()
    return
  }
  res.status(404).json({ error: 'Cashier services are not available in the remote admin portal.' })
})

app.post('/api/cashier/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const user = await authenticateRoleUser(email, password, 'cashier')
  await createLog({ userId: user.id, action: 'Login', detail: 'Signed in to cashier POS' })
  res.json({ ok: true, user })
}))

app.post('/api/cashier/auth/barcode', asyncRoute(async (req, res) => {
  const barcode = String(req.body?.barcode || '').trim()

  if (!barcode) {
    return res.status(400).json({ error: 'Cashier barcode is required.' })
  }
  const user = await (await pbCollection('users')).getFirstListItem(
    pb.filter('void_barcode = {:barcode} && role = "cashier" && status != "inactive"', { barcode }),
    { requestKey: null },
  ).catch(() => null)

  if (!user) {
    return res.status(401).json({ error: 'Invalid cashier barcode.' })
  }

  await createLog({ userId: user.id, action: 'Login', detail: 'Signed in to cashier POS using barcode' })
  res.json({ ok: true, user })
}))

const publicAdminPaths = new Set([
  '/health',
  '/auth/login',
])

app.use('/api', asyncRoute(async (req, res, next) => {
  if (req.path.startsWith('/cashier/') || publicAdminPaths.has(req.path)) {
    next()
    return
  }

  const authorization = String(req.headers.authorization || '')
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : ''
  req.adminUser = await authenticateAdminToken(token)
  res.setHeader('Cache-Control', 'private, no-store')
  next()
}))

app.get('/api/products', asyncRoute(async (_req, res) => {
  const records = await listRecords('products', '?sort=name&expand=category&perPage=500')
  res.json(records.map(toProduct))
}))

app.get('/api/categories', asyncRoute(async (_req, res) => {
  const records = await listRecords('categories', '?sort=name&perPage=500')
  res.json(records.map((record) => ({
    id: record.id,
    name: record.name || '',
    updated: record.updated || record.created || '',
  })))
}))

app.post('/api/categories', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Category name is required.' })

  const id = await getOrCreateCategoryId(name)
  const record = await (await pbCollection('categories')).getOne(id)
  await createLog({ action: 'Settings', detail: `Created category "${record.name}"` })
  res.status(201).json({
    id: record.id,
    name: record.name || name,
    updated: record.updated || record.created || '',
  })
}))

app.get('/api/cashier/products', asyncRoute(async (_req, res) => {
  const records = await listRecords('products', '?sort=name&expand=category&perPage=500')
  res.json(records.map(toProduct))
}))

app.get('/api/cashier/products/barcode/:barcode', asyncRoute(async (req, res) => {
  const barcode = String(req.params.barcode || '').trim()
  if (!barcode) return res.status(400).json({ error: 'Barcode is required.' })

  const matched = await findProductByScanBarcode(barcode)
  if (!matched) return res.status(404).json({ error: `No product found for barcode "${barcode}".` })

  const record = await (await pbCollection('products')).getOne(matched.id, { expand: 'category' })
  const product = toProduct(record)
  const matchingUnit = parseSellingUnits(record.selling_units ?? record.sellingUnits)
    .find((unit) => String(unit?.barcode || '').trim() === barcode)
  if (matchingUnit) {
    product.barcode = barcode
    product.unit = String(matchingUnit.unit || product.unit).trim() || product.unit
    product.price = Number(matchingUnit.price) || product.price
    product.conversion = Number(matchingUnit.conversion) > 0 ? Number(matchingUnit.conversion) : 1
    product.matchingUnit = {
      barcode: barcode,
      unit: product.unit,
      conversion: product.conversion,
      price: product.price,
    }
  } else {
    product.conversion = 1
  }

  if (product.qty <= 0) return res.status(409).json({ error: `"${product.name}" is out of stock.` })
  res.json(product)
}))

app.post('/api/cashier/authorize-void', asyncRoute(async (req, res) => {
  const approver = await authorizeManagerApproval({
    code: req.body?.code,
    email: req.body?.email,
    password: req.body?.password,
  })
  res.json({ ok: true, approver })
}))

app.post('/api/cashier/activity-log', asyncRoute(async (req, res) => {
  const cashierId = String(req.body?.cashierId || '').trim()
  const action = String(req.body?.action || '').trim()
  const detail = String(req.body?.detail || '').trim()

  if (!cashierId) return res.status(400).json({ error: 'Cashier is required.' })
  if (!action || !detail) return res.status(400).json({ error: 'Action and detail are required.' })

  await createLog({
    userId: cashierId,
    action,
    detail,
  })
  res.status(201).json({ ok: true })
}))

app.get('/api/cashier/sales', asyncRoute(async (req, res) => {
  const cashierId = String(req.query?.cashierId || '').trim()
  const search = String(req.query?.q || '').trim().toLowerCase()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sales = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    filter: cashierId ? pb.filter('cashier_id = {:cashierId}', { cashierId }) : '',
    expand: 'cashier_id',
  })

  const todaysSales = sales
    .filter((sale) => new Date(sale.created_at || sale.created) >= todayStart)
    .filter((sale) => {
      if (!search) return true
      return String(sale.transaction_no || sale.id).toLowerCase().includes(search)
    })
    .slice(0, 50)

  const saleItems = await pbCollection('sale_items')
  const history = []

  for (const sale of todaysSales) {
    let paymentMethod = sale.payment_method || ''
    let refNumber = sale.ref_number || ''
    let splitPayments = null
    if (String(refNumber).startsWith('split:')) {
      try {
        splitPayments = JSON.parse(String(refNumber).slice(6))
        paymentMethod = 'split'
        refNumber = ''
      } catch {
        paymentMethod = 'split'
      }
    }

    const items = await saleItems.getFullList({
      sort: 'created',
      filter: pb.filter('sale_id = {:saleId}', { saleId: sale.id }),
      expand: 'product_id',
    })

    history.push({
      id: sale.id,
      transactionNo: sale.transaction_no || sale.id,
      totalAmount: Number(sale.total_amount) || 0,
      subtotalAmount: Number(sale.total_amount) || 0,
      discountPercent: 0,
      discountAmount: 0,
      paymentMethod,
      refNumber,
      splitPayments,
      gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount) || 0 : '',
      status: sale.status || 'completed',
      createdAt: sale.created_at || sale.created,
      cashierName: (Array.isArray(sale.expand?.cashier_id) ? sale.expand.cashier_id[0] : sale.expand?.cashier_id)?.name
        || (Array.isArray(sale.expand?.cashier_id) ? sale.expand.cashier_id[0] : sale.expand?.cashier_id)?.email
        || String(sale.cashier_id || ''),
      itemCount: items.reduce((sum, item) => sum + (Number(item.quantity_sold) || 0), 0),
      items: items.map((item) => {
        const product = Array.isArray(item.expand?.product_id)
          ? item.expand.product_id[0]
          : item.expand?.product_id
        return {
          id: item.id,
          name: product?.name || item.product_id || 'Product',
          quantity: Number(item.quantity_sold) || 0,
          price: Number(item.price_at_sale) || 0,
        }
      }),
    })
  }

  res.json(history)
}))

app.get('/api/receipts', asyncRoute(async (req, res) => {
  const q = String(req.query?.q || '').trim().toLowerCase()
  const cashierName = String(req.query?.cashierName || '').trim().toLowerCase()
  const status = String(req.query?.status || 'all').trim().toLowerCase()
  const action = String(req.query?.action || 'all').trim().toLowerCase()
  const fromDate = String(req.query?.fromDate || '').trim()
  const toDate = String(req.query?.toDate || '').trim()

  const sales = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    perPage: 500,
  })
  const saleItems = await pbCollection('sale_items')
  const records = await Promise.all(sales.map((sale) => receiptRecordFromSale(sale, saleItems)))

  const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
  const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null

  res.json(records.filter((record) => {
    const createdTime = new Date(record.createdAt).getTime()
    const queryMatches = !q || [
      record.transactionNo,
      record.receiptNo,
      record.cashierName,
      record.paymentMethod,
    ].some((value) => String(value || '').toLowerCase().includes(q))
    const cashierMatches = !cashierName || String(record.cashierName || '').toLowerCase() === cashierName
    const statusMatches = status === 'all' || String(record.rawStatus || '').toLowerCase() === status
    const actionMatches = action === 'all'
      || (action === 'reprintable' && record.rawStatus !== 'voided')
      || (action === 'voided' && record.rawStatus === 'voided')
    const dateMatches = (!fromTime || createdTime >= fromTime) && (!toTime || createdTime <= toTime)
    return queryMatches && cashierMatches && statusMatches && actionMatches && dateMatches
  }))
}))

app.get('/api/cashier/next-transaction-number', asyncRoute(async (_req, res) => {
  res.json({ transactionNo: await nextTransactionNumber() })
}))

app.post('/api/cashier/sales', asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const cashierId = String(req.body?.cashierId || '').trim()
  const paymentMethod = req.body?.paymentMethod === 'gcash' ? 'gcash' : 'cash'
  const refNumber = String(req.body?.refNumber || '').trim()
  const totalAmount = Number(req.body?.totalAmount) || 0
  const subtotalAmount = Number(req.body?.subtotalAmount) || totalAmount
  const discountPercent = Number(req.body?.discountPercent) || 0
  const discountAmount = Number(req.body?.discountAmount) || 0
  const transactionNo = await nextTransactionNumber()

  if (!cashierId) return res.status(400).json({ error: 'Cashier is required.' })
  if (items.length === 0) return res.status(400).json({ error: 'Sale must have at least one item.' })
  if (totalAmount <= 0) return res.status(400).json({ error: 'Sale total must be greater than zero.' })

  const products = await pbCollection('products')
  const saleItems = await pbCollection('sale_items')
  const sales = await pbCollection('sales')

  const productRecords = []
  for (const item of items) {
    const product = await products.getOne(item.productId)
    const quantity = Number(item.quantity) || 0
    if (quantity <= 0) return res.status(400).json({ error: `Invalid quantity for "${product.name}".` })

    const matchingUnit = parseSellingUnits(product.selling_units).find((unit) => String(unit?.barcode || '').trim() === String(item.barcode || '').trim())
    const conversion = Number(item.conversion) > 0
      ? Number(item.conversion)
      : (Number(matchingUnit?.conversion) > 0 ? Number(matchingUnit.conversion) : 1)
    const baseQuantity = quantity * conversion

    if ((Number(product.quantity) || 0) < baseQuantity) {
      return res.status(409).json({ error: `"${product.name}" has only ${product.quantity || 0} base unit(s) left.` })
    }

    productRecords.push({ product, item, quantity, baseQuantity })
  }

  const sale = await sales.create({
    transaction_no: transactionNo,
    cashier_id: cashierId,
    total_amount: totalAmount,
    subtotal_amount: subtotalAmount,
    discount_percent: discountPercent,
    discount_amount: discountAmount,
    payment_method: paymentMethod,
    ref_number: refNumber,
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  for (const { product, item, quantity, baseQuantity } of productRecords) {
    const previousQty = Number(product.quantity) || 0
    const nextQty = Math.max(0, previousQty - baseQuantity)
    await saleItems.create({
      sale_id: sale.id,
      product_id: product.id,
      quantity_sold: quantity,
      price_at_sale: Number(item.price) || Number(product.price) || 0,
      base_quantity_sold: baseQuantity,
      matching_unit_barcode: String(item.barcode || '').trim(),
    })
    await products.update(product.id, {
      quantity: numberFieldValue(nextQty),
    })
    await createStockMovement({
      productId: product.id,
      movementType: 'sale',
      quantity: baseQuantity,
      previousQuantity: previousQty,
      newQuantity: nextQty,
      referenceType: 'sale',
      referenceId: sale.id,
      userId: cashierId,
      notes: `Sale ${transactionNo}`,
      createdAt: sale.created_at || new Date().toISOString(),
    })
  }

  await createLog({
    userId: cashierId,
    action: 'Sale',
    detail: `Completed transaction ${transactionNo} - PHP ${totalAmount.toFixed(2)}`,
  })

  if (discountAmount > 0 || discountPercent > 0) {
    await createLog({
      userId: cashierId,
      action: 'Discount',
      detail: `Applied ${discountPercent}% discount (${discountAmount.toFixed(2)} off ${subtotalAmount.toFixed(2)}) on transaction ${transactionNo}`,
    })
  }

  res.status(201).json({ id: sale.id, transactionNo, totalAmount, subtotalAmount, discountPercent, discountAmount })
}))

app.post('/api/cashier/sales/:id/void', asyncRoute(async (req, res) => {
  const saleId = String(req.params.id || '').trim()
  const cashierId = String(req.body?.cashierId || '').trim()
  const reason = String(req.body?.reason || '').trim()
  if (!saleId) return res.status(400).json({ error: 'Sale is required.' })

  const approver = await authorizeManagerApproval({
    code: req.body?.code,
    email: req.body?.email,
    password: req.body?.password,
  })

  const sales = await pbCollection('sales')
  const saleItems = await pbCollection('sale_items')
  const products = await pbCollection('products')
  const sale = await sales.getOne(saleId).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (!sale) return res.status(404).json({ error: 'Completed sale not found.' })
  if ((sale.status || 'completed') === 'voided') {
    return res.status(409).json({ error: 'This transaction has already been voided.' })
  }

  const items = await saleItems.getFullList({
    filter: pb.filter('sale_id = {:saleId}', { saleId }),
  })

  for (const item of items) {
    const productId = productRelationId(item.product_id)
    if (!productId) continue
    const product = await products.getOne(productId)
    const previousQty = Number(product.quantity) || 0
    let returnedQty = Number(item.base_quantity_sold) || 0
    if (!returnedQty) {
      // Fallback: try to infer conversion from matching_unit_barcode or unit price
      const sellingUnits = parseSellingUnits(product.selling_units ?? product.sellingUnits)
      const matchingByBarcode = sellingUnits.find((u) => String(u?.barcode || '').trim() && String(u.barcode).trim() === String(item.matching_unit_barcode || '').trim())
      if (matchingByBarcode) {
        returnedQty = (Number(item.quantity_sold) || 0) * (Number(matchingByBarcode.conversion) > 0 ? Number(matchingByBarcode.conversion) : 1)
      } else {
        const matchingByPrice = sellingUnits.find((u) => Number(u?.price) && Number(u.price) === Number(item.price_at_sale))
        if (matchingByPrice) {
          returnedQty = (Number(item.quantity_sold) || 0) * (Number(matchingByPrice.conversion) > 0 ? Number(matchingByPrice.conversion) : 1)
        } else {
          // Last resort: assume quantity_sold is already base units
          returnedQty = Number(item.quantity_sold) || 0
        }
      }
    }
    const nextQty = previousQty + returnedQty
    await products.update(product.id, {
      quantity: numberFieldValue(nextQty),
    })
    await createStockMovement({
      productId: product.id,
      movementType: 'void_return',
      quantity: returnedQty,
      previousQuantity: previousQty,
      newQuantity: nextQty,
      referenceType: 'void',
      referenceId: sale.id,
      userId: cashierId || productRelationId(sale.cashier_id),
      notes: `Voided sale ${sale.transaction_no || sale.id}${reason ? `: ${reason}` : ''}`,
    })
  }

  const updatedSale = await sales.update(saleId, {
    status: 'voided',
    voided_by: approver.id || '',
  })

  await createLog({
    userId: cashierId || productRelationId(sale.cashier_id),
    action: 'Transaction Void',
    detail: `Voided completed transaction ${sale.transaction_no || sale.id} approved by ${approver.name}${reason ? ` (${reason})` : ''}`,
  })

  res.json({
    ok: true,
    sale: {
      id: updatedSale.id,
      transactionNo: updatedSale.transaction_no || updatedSale.id,
      status: updatedSale.status || 'voided',
      approvedBy: approver.name,
      voidedAt: new Date().toISOString(),
    },
  })
}))

app.post('/api/products', upload.single('product_img'), asyncRoute(async (req, res) => {
  const body = productRequestBody(req)
  const categoryId = await getOrCreateCategoryId(body.category)
  const payload = productRecordPayload(body, categoryId, req.file)
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Product name is required.' })

  const created = await (await pbCollection('products')).create(payload, { expand: 'category' })
  await createLog({ action: 'Product', detail: `Added product "${body.name}"` })
  res.status(201).json(toProduct(created))
}))

app.patch('/api/products/:id', upload.single('product_img'), asyncRoute(async (req, res) => {
  const body = productRequestBody(req)
  const categoryId = await getOrCreateCategoryId(body.category)
  const payload = productRecordPayload(body, categoryId, req.file)
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Product name is required.' })

  const updated = await (await pbCollection('products')).update(req.params.id, payload, { expand: 'category' })
  await createLog({ action: 'Product', detail: `Updated product "${body.name}"` })
  res.json(toProduct(updated))
}))

app.delete('/api/products/:id', asyncRoute(async (req, res) => {
  try {
    await (await pbCollection('products')).delete(req.params.id)
  } catch (error) {
    const message = error?.message || ''
    const isRelationConstraint = /required relation|relation reference|foreign key|dependent/i.test(message)
    if (!isRelationConstraint && error?.status !== 404) throw error
  }

  await createLog({ action: 'Product', detail: `Deleted product ${req.params.id}` })
  res.status(204).end()
}))

app.post('/api/inventory/scan', asyncRoute(async (req, res) => {
  const barcode = String(req.body.barcode || '').trim()
  const productId = String(req.body.productId || '').trim()
  const qty = Number(req.body.qty) || 1
  if (!barcode && !productId) return res.status(400).json({ error: 'Barcode or product is required.' })

  const products = await pbCollection('products')
  const record = productId
    ? await products.getOne(productId, { expand: 'category' }).catch(() => null)
    : await findProductByScanBarcode(barcode)
  if (!record) return res.status(404).json({ error: barcode ? `No product found for barcode "${barcode}".` : 'No product found.' })

  const matchingUnit = parseSellingUnits(record.selling_units).find((unit) => String(unit?.barcode || '').trim() === barcode)
  const requestConversion = Number(req.body.unitConversion)
  const conversion = Number(matchingUnit?.conversion) > 0
    ? Number(matchingUnit.conversion)
    : (Number.isFinite(requestConversion) && requestConversion > 0 ? requestConversion : 1)
  const previousQty = Number(record.quantity) || 0
  const movementQty = qty * conversion
  const nextQty = previousQty + movementQty
  const updated = await products.update(record.id, { quantity: numberFieldValue(nextQty) }, { expand: 'category' })
  await createStockMovement({
    productId: record.id,
    movementType: 'stock_in',
    quantity: movementQty,
    previousQuantity: previousQty,
    newQuantity: nextQty,
    referenceType: 'inventory_scan',
    notes: `Stock in by ${barcode ? `barcode ${barcode}` : `${qty} ${req.body.unitLabel || 'unit(s)'}`}`,
  })
  await createLog({ action: 'Stock Update', detail: `Added ${qty * conversion} base unit(s) to "${record.name}"` })
  res.json(toProduct(updated))
}))

app.post('/api/inventory/stock-out', asyncRoute(async (req, res) => {
  const barcode = String(req.body.barcode || '').trim()
  const productId = String(req.body.productId || '').trim()
  const qty = Math.max(1, Math.floor(Number(req.body.qty) || 1))
  const reason = String(req.body.reason || 'other').trim()
  const note = String(req.body.note || '').trim()
  if (!barcode && !productId) return res.status(400).json({ error: 'Barcode or product is required.' })

  const products = await pbCollection('products')
  const record = productId
    ? await products.getOne(productId, { expand: 'category' }).catch(() => null)
    : await findProductByScanBarcode(barcode)
  if (!record) return res.status(404).json({ error: barcode ? `No product found for barcode "${barcode}".` : 'No product found.' })

  const matchingUnit = parseSellingUnits(record.selling_units).find((unit) => String(unit?.barcode || '').trim() === barcode)
  const requestConversion = Number(req.body.unitConversion)
  const conversion = Number(matchingUnit?.conversion) > 0
    ? Number(matchingUnit.conversion)
    : (Number.isFinite(requestConversion) && requestConversion > 0 ? requestConversion : 1)
  const currentQty = Number(record.quantity) || 0
  const baseUnitsToRemove = qty * conversion
  if (currentQty < baseUnitsToRemove) return res.status(409).json({ error: `"${record.name}" has only ${currentQty} base unit(s) in stock.` })

  const nextQty = currentQty - baseUnitsToRemove
  const updated = await products.update(record.id, {
    quantity: numberFieldValue(nextQty),
  }, { expand: 'category' })
  await createStockMovement({
    productId: record.id,
    movementType: 'stock_out',
    quantity: baseUnitsToRemove,
    previousQuantity: currentQty,
    newQuantity: nextQty,
    referenceType: 'stock_out',
    notes: `${reason}${note ? ` (${note})` : ''}`,
  })
  await createLog({
    action: 'Stock Out',
    detail: `Removed ${baseUnitsToRemove} base unit(s) from "${record.name}" - ${reason}${note ? ` (${note})` : ''}`,
  })
  res.json(toProduct(updated))
}))

app.get('/api/inventory/fsn', asyncRoute(async (_req, res) => {
  const now = new Date()
  const products = (await listRecords('products', '?expand=category&perPage=500')).map(toProduct)
  const sales = await listRecords('sales', '?filter=status!="voided"&perPage=500')
  const saleItems = await listRecords('sale_items', '?expand=product_id&perPage=500')
  const metrics = buildSalesMetrics(products, sales, saleItems, now)
  const classified = products.map((product) => classifyFsnProduct(product, metrics.get(product.id), now))
  res.json(classified)
}))

function staffRoleFromRequest(req) {
  return String(req.query?.role || req.body?.role || 'cashier').trim() === 'manager' ? 'manager' : 'cashier'
}

function isManagerStaffRecord(record = {}) {
  return record.role === 'manager' || (record.role === 'cashier' && String(record.void_barcode || '').startsWith('92'))
}

app.get('/api/cashiers', asyncRoute(async (req, res) => {
  const role = staffRoleFromRequest(req)
  const records = await listRecords('users', '?sort=email&perPage=500')
  const staffRecords = records.filter((record) => (
    role === 'manager'
      ? isManagerStaffRecord(record)
      : record.role === 'cashier' && !isManagerStaffRecord(record)
  ))
  const salesByCashier = await getSalesByCashier()
  res.json(staffRecords.map((record) => toCashier(record, salesByCashier.get(record.id))))
}))

app.post('/api/cashiers', upload.single('profile_img'), asyncRoute(async (req, res) => {
  const payload = cashierFormData(req.body || {}, req.file)
  if (!payload.name || !payload.email) {
    return res.status(400).json({ error: 'Name and email are required.' })
  }

  const created = await (await pbCollection('users')).create(payload)
  const staffRole = staffRoleFromRequest(req)
  await createLog({ action: staffRole === 'manager' ? 'Manager' : 'Cashier', detail: `Added ${staffRole} "${payload.email}"` })
  res.status(201).json(toCashier(created))
}))

app.patch('/api/cashiers/:id', upload.single('profile_img'), asyncRoute(async (req, res) => {
  const payload = cashierFormData(req.body || {}, req.file)
  if (!String(req.body?.password || '').trim()) {
    delete payload.password
    delete payload.passwordConfirm
  }
  const updated = await (await pbCollection('users')).update(req.params.id, payload)
  const staffRole = staffRoleFromRequest(req)
  await createLog({ action: staffRole === 'manager' ? 'Manager' : 'Cashier', detail: `Updated ${staffRole} "${payload.email}"` })
  res.json(toCashier(updated))
}))

app.get('/api/settings/cashiers', asyncRoute(async (_req, res) => {
  const records = (await listRecords('users', '?filter=role%3D%22cashier%22&sort=email&perPage=500'))
    .filter((record) => !isManagerStaffRecord(record))
  const salesByCashier = await getSalesByCashier()
  res.json(records.map((record) => toCashier(record, salesByCashier.get(record.id))))
}))

app.get('/api/settings/admins', asyncRoute(async (_req, res) => {
  const records = await listRecords('users', '?filter=role="admin"&sort=email&perPage=500')
  res.json(records.map(toUserAccount))
}))

app.patch('/api/settings/cashiers/:id/quick-login', asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const updated = await (await pbCollection('users')).update(req.params.id, {
    quick_login_enabled: enabled,
    ...(enabled ? { emailVisibility: true } : {}),
  })
  await createLog({
    action: 'Settings',
    detail: `${enabled ? 'Enabled' : 'Disabled'} quick login for "${updated.email}"`,
  })
  res.json(toCashier(updated))
}))

app.patch('/api/settings/admins/:id/quick-login', asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const updated = await (await pbCollection('users')).update(req.params.id, {
    quick_login_enabled: enabled,
    ...(enabled ? { emailVisibility: true } : {}),
  })
  await createLog({
    action: 'Settings',
    detail: `${enabled ? 'Enabled' : 'Disabled'} admin quick login for "${updated.email}"`,
  })
  res.json(toUserAccount(updated))
}))

app.patch('/api/settings/admins/:id/authorization-barcode', asyncRoute(async (req, res) => {
  const barcode = String(req.body?.barcode || '').trim()
  if (!barcode) return res.status(400).json({ error: 'Authorization barcode is required.' })

  const created = await (await pbCollection('authorization_barcodes')).create({
    code: barcode,
    label: 'Void and Discount Approval',
    purpose: 'void_discount',
    status: 'active',
    generated_by: req.params.id,
  })
  await createLog({
    action: 'Settings',
    detail: 'Generated authorization barcode for void and discount approvals',
  })
  res.json(created)
}))

app.get('/api/barcodes/product/next', asyncRoute(async (_req, res) => {
  res.json({ barcode: await nextProductBarcode() })
}))

app.get('/api/barcodes/authorization/latest', asyncRoute(async (_req, res) => {
  const records = await (await pbCollection('authorization_barcodes')).getFullList({
    sort: '-created',
    filter: 'status = "active"',
    expand: 'generated_by',
  })
  const latest = records[0]
  if (!latest) return res.status(204).end()

  const generatedBy = Array.isArray(latest.expand?.generated_by)
    ? latest.expand.generated_by[0]
    : latest.expand?.generated_by

  res.json({
    id: latest.id,
    barcode: latest.code,
    label: latest.label,
    status: latest.status,
    generatedBy: generatedBy?.name || generatedBy?.email || 'Admin',
    createdAt: latest.created,
  })
}))

app.get('/api/barcodes/authorization', asyncRoute(async (_req, res) => {
  const records = await (await pbCollection('authorization_barcodes')).getFullList({
    sort: '-created',
    expand: 'generated_by',
  })

  res.json(records.map((record) => {
    const generatedBy = Array.isArray(record.expand?.generated_by)
      ? record.expand.generated_by[0]
      : record.expand?.generated_by

    return {
      id: record.id,
      barcode: record.code,
      label: record.label,
      status: record.status,
      generatedBy: generatedBy?.name || generatedBy?.email || 'Admin',
      createdAt: record.created,
    }
  }))
}))

app.patch('/api/barcodes/authorization/:id/status', asyncRoute(async (req, res) => {
  const status = req.body?.status === 'revoked' ? 'revoked' : 'active'
  const updated = await (await pbCollection('authorization_barcodes')).update(req.params.id, { status }, {
    expand: 'generated_by',
  })
  const generatedBy = Array.isArray(updated.expand?.generated_by)
    ? updated.expand.generated_by[0]
    : updated.expand?.generated_by

  await createLog({
    action: 'Settings',
    detail: `${status === 'active' ? 'Enabled' : 'Disabled'} authorization barcode ${updated.code}`,
  })

  res.json({
    id: updated.id,
    barcode: updated.code,
    label: updated.label,
    status: updated.status,
    generatedBy: generatedBy?.name || generatedBy?.email || 'Admin',
    createdAt: updated.created,
  })
}))

app.delete('/api/barcodes/authorization/:id', asyncRoute(async (req, res) => {
  await (await pbCollection('authorization_barcodes')).delete(req.params.id)
  await createLog({
    action: 'Settings',
    detail: `Deleted authorization barcode ${req.params.id}`,
  })
  res.status(204).end()
}))

app.post('/api/barcodes/authorization', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ error: 'Admin password is required.' })

  const user = await authenticateAdminUser(email, password)
  const barcode = await nextAuthorizationBarcode()
  const created = await (await pbCollection('authorization_barcodes')).create({
    code: barcode,
    label: 'Void and Discount Approval',
    purpose: 'void_discount',
    status: 'active',
    generated_by: user.id,
  })
  await createLog({
    userId: user.id,
    action: 'Settings',
    detail: 'Generated authorization barcode for void and discount approvals',
  })
  res.status(201).json({
    id: created.id,
    barcode: created.code,
    label: created.label,
    status: created.status,
    generatedBy: user.name || user.email,
    createdAt: created.created,
  })
}))

app.get('/api/auth/quick-login-accounts', asyncRoute(async (_req, res) => {
  const records = await (await pbCollection('users')).getFullList({
    sort: 'email',
    filter: 'role="admin" && quick_login_enabled=true && status!="inactive"',
  })
  res.json(records.map(toUserAccount))
}))

app.get('/api/cashier/quick-login-accounts', asyncRoute(async (_req, res) => {
  const records = await (await pbCollection('users')).getFullList({
    sort: 'email',
    filter: 'role="cashier" && quick_login_enabled=true && status!="inactive"',
  })
  res.json(records.map((record) => toCashier(record)))
}))

app.delete('/api/cashiers/:id', asyncRoute(async (req, res) => {
  await (await pbCollection('users')).delete(req.params.id)
  await createLog({ action: 'Cashier', detail: `Removed cashier ${req.params.id}` })
  res.status(204).end()
}))

app.get('/api/activity-logs', asyncRoute(async (_req, res) => {
  const records = await listRecords('activity_logs', '?sort=-timestamp,-created&expand=user_id&perPage=500')
  res.json(records.map(toActivityLog))
}))

app.post('/api/audit-reviews', asyncRoute(async (req, res) => {
  const reviewedBy = String(req.body?.reviewedBy || '').trim()
    || (await (await pbCollection('users')).getFirstListItem('role="admin"', { fields: 'id' }).catch(() => null))?.id
  if (!reviewedBy) return res.status(400).json({ error: 'Admin reviewer is required.' })

  const fromDate = String(req.body?.fromDate || '').trim()
  const toDate = String(req.body?.toDate || '').trim()
  const reviewedAt = new Date().toISOString()
  const created = await (await pbCollection('audit_reviews')).create({
    reviewed_by: reviewedBy,
    date_from: fromDate ? `${fromDate}T00:00:00.000Z` : reviewedAt,
    date_to: toDate ? `${toDate}T23:59:59.999Z` : reviewedAt,
    row_count: Math.max(0, Math.floor(Number(req.body?.rowCount) || 0)),
    note: String(req.body?.note || '').trim(),
    reviewed_at: reviewedAt,
  })

  await createLog({
    userId: reviewedBy,
    action: 'Audit Review',
    detail: `Marked audit range ${fromDate || 'all'} to ${toDate || 'all'} as reviewed.`,
  })

  res.status(201).json({
    id: created.id,
    reviewedAt: created.reviewed_at,
    rowCount: created.row_count,
  })
}))

function dashboardSaleSource(sale = {}) {
  const transactionNo = String(sale.transaction_no || '')
  if (['202606160001', '202606160002'].includes(transactionNo)) return 'sample'
  if (/^sal\d{12}$/.test(String(sale.id || '')) || /^99\d{12}$/.test(transactionNo)) return 'legacy'
  return 'live'
}

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const products = (await listRecords('products', '?expand=category&perPage=500')).map(toProduct)
  let sales = await listRecords('sales', '?perPage=500')
  let saleItems = await listRecords('sale_items', '?expand=product_id&perPage=500')
  const source = String(req.query.source || 'all')
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : null
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999`) : null
  sales = sales.filter((sale) => (source === 'all' || dashboardSaleSource(sale) === source)
    && (!from || saleDate(sale) >= from) && (!to || saleDate(sale) <= to))
  const filteredSaleIds = new Set(sales.map((sale) => sale.id))
  saleItems = saleItems.filter((item) => filteredSaleIds.has(Array.isArray(item.sale_id) ? item.sale_id[0] : item.sale_id))
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const completedSales = sales.filter((sale) => (sale.status || 'completed') !== 'voided')
  const dailySales = completedSales
    .filter((sale) => new Date(sale.created_at || sale.created) >= todayStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const yesterdaySales = completedSales
    .filter((sale) => {
      const created = saleDate(sale)
      return created >= yesterdayStart && created < todayStart
    })
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const monthlySales = completedSales
    .filter((sale) => new Date(sale.created_at || sale.created) >= monthStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const lastMonthSales = completedSales
    .filter((sale) => {
      const created = saleDate(sale)
      return created >= lastMonthStart && created < monthStart
    })
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const totalRevenue = completedSales.reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const currentStockUnits = products.reduce((sum, product) => sum + (Number(product.qty) || 0), 0)
  const selectedUnitsSold = saleItems.reduce((sum, item) => sum + (Number(item.quantity_sold) || 0), 0)

  const criticalStockProducts = products
    .filter(isCriticalStock)
    .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0))
  const criticalAlerts = criticalStockProducts
    .slice(0, 5)
    .map((product) => ({ name: product.name, left: product.qty }))

  const productsById = new Map(products.map((product) => [product.id, product]))
  const productSales = new Map()
  for (const item of saleItems) {
    const productId = Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
    if (!productId) continue
    const expandedProduct = Array.isArray(item.expand?.product_id)
      ? item.expand.product_id[0]
      : item.expand?.product_id
    const current = productSales.get(productId) || {
      id: productId,
      name: expandedProduct?.name || productsById.get(productId)?.name || productId,
      category: productsById.get(productId)?.category || expandedProduct?.category || '',
      units: 0,
    }
    current.units += Number(item.quantity_sold) || 0
    productSales.set(productId, current)
  }

  const topProducts = [...productSales.values()]
    .filter((product) => product.units > 0)
    .sort((a, b) => b.units - a.units)
    .slice(0, 5)
  const paymentTotals = completedSales.reduce((totals, sale) => {
    const amount = Number(sale.total_amount) || 0
    if (String(sale.payment_method || 'cash').toLowerCase() === 'gcash') totals.gcash += amount
    else totals.cash += amount
    return totals
  }, { cash: 0, gcash: 0 })
  const inventoryHealth = [
    { label: 'In Stock', value: products.filter((p) => p.status === 'in-stock').length, color: '#16a34a' },
    { label: 'Low', value: products.filter((p) => p.status === 'low').length, color: '#f59e0b' },
    { label: 'Critical', value: products.filter((p) => p.status === 'critical').length, color: '#f97316' },
    { label: 'Out of Stock', value: products.filter((p) => p.status === 'out-of-stock').length, color: '#ef4444' },
  ]
  const topCategoryMap = new Map()
  for (const product of productSales.values()) topCategoryMap.set(product.category || 'Uncategorized', (topCategoryMap.get(product.category || 'Uncategorized') || 0) + product.units)
  const hourlySales = Array.from({ length: 24 }, (_, hour) => ({
    label: `${String(hour).padStart(2, '0')}:00`,
    value: 0,
  }))
  for (const sale of completedSales) {
    const created = saleDate(sale)
    if (created < todayStart) continue
    hourlySales[created.getHours()].value += Number(sale.total_amount) || 0
  }
  const monthlyTrend = lastMonths(8, now)
  const dailyTrend = lastDays(7, now)
  const weeklyTrend = lastWeeks(8, now)
  const yearlyTrend = lastYears(5, now)
  const monthlyTrendByKey = new Map(monthlyTrend.map((item) => [item.key, item]))
  const dailyTrendByKey = new Map(dailyTrend.map((item) => [item.key, item]))
  const weeklyTrendByKey = new Map(weeklyTrend.map((item) => [item.key, item]))
  const yearlyTrendByKey = new Map(yearlyTrend.map((item) => [item.key, item]))
  for (const sale of completedSales) {
    const created = saleDate(sale)
    const amount = Number(sale.total_amount) || 0
    const day = dailyTrendByKey.get(dateKey(created))
    if (day) day.value += amount
    const week = weeklyTrendByKey.get(weekKey(created))
    if (week) week.value += amount
    const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`
    const month = monthlyTrendByKey.get(key)
    if (month) month.value += amount
    const year = yearlyTrendByKey.get(String(created.getFullYear()))
    if (year) year.value += amount
  }
  const trend = (current, previous) => {
    if (!previous) return current > 0 ? 100 : 0
    return Math.round(((current - previous) / previous) * 100)
  }

  res.json({
    stats: {
      dailySales,
      dailySalesTrend: trend(dailySales, yesterdaySales),
      monthlySales,
      monthlySalesTrend: trend(monthlySales, lastMonthSales),
      totalRevenue,
      totalRevenueTrend: 0,
      criticalStock: criticalStockProducts.length,
      transactionCount: completedSales.length,
      averageSale: completedSales.length ? totalRevenue / completedSales.length : 0,
      cashSales: paymentTotals.cash,
      gcashSales: paymentTotals.gcash,
      unitsSold: selectedUnitsSold,
      voidCount: sales.filter((sale) => (sale.status || 'completed') === 'voided').length,
    },
    criticalAlerts,
    productInOut: [
      { label: 'Current Stock', value: currentStockUnits, color: '#4f46e5' },
      { label: 'Units Sold', value: selectedUnitsSold, color: '#16a34a' },
    ],
    topProducts,
    hourlySales,
    dailySales: dailyTrend,
    weeklySales: weeklyTrend,
    monthlySales: monthlyTrend,
    yearlySales: yearlyTrend,
    analyticsMeta: { source, from: req.query.from || '', to: req.query.to || '', salesCount: completedSales.length },
    inventoryHealth,
    paymentBreakdown: [{ label: 'Cash', value: paymentTotals.cash, color: '#16a34a' }, { label: 'GCash', value: paymentTotals.gcash, color: '#2563eb' }],
    recentTransactions: [...completedSales].sort((a, b) => saleDate(b) - saleDate(a)).slice(0, 5).map((sale) => ({ id: sale.id, transactionNo: sale.transaction_no || sale.id, amount: Number(sale.total_amount) || 0, paymentMethod: sale.payment_method || 'cash', createdAt: saleDate(sale).toISOString() })),
    topCategories: [...topCategoryMap].map(([name, units]) => ({ name, units })).sort((a, b) => b.units - a.units).slice(0, 5),
    dataQuality: {
      generatedBarcodes: products.filter((p) => !p.barcode || String(p.barcode).startsWith('LEGACY-')).length,
      uncategorized: products.filter((p) => !p.category || /uncategorized/i.test(p.category)).length,
      nonPositivePrices: products.filter((p) => Number(p.price) <= 0).length,
    },
  })
}))

app.get('/api/gcash-payments', asyncRoute(async (_req, res) => {
  const records = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
  })

  res.json(records.map(gcashPaymentFromSale).filter(Boolean))
}))

app.post('/api/inventory/adjust-count', asyncRoute(async (req, res) => {
  const productId = String(req.body.productId || '').trim()
  const countedQty = Number(req.body.countedQty)
  const reason = String(req.body.reason || '').trim()
  const note = String(req.body.note || '').trim()
  if (!productId) return res.status(400).json({ error: 'Product is required.' })
  if (!Number.isFinite(countedQty) || countedQty < 0) return res.status(400).json({ error: 'Physical count must be zero or greater.' })
  if (!reason) return res.status(400).json({ error: 'Adjustment reason is required.' })
  const products = await pbCollection('products')
  const record = await products.getOne(productId, { expand: 'category' }).catch(() => null)
  if (!record) return res.status(404).json({ error: 'Product was not found.' })
  const previousQty = Number(record.quantity) || 0
  const delta = countedQty - previousQty
  if (!delta) return res.status(409).json({ error: 'Physical count already matches system stock.' })
  const updated = await products.update(record.id, { quantity: numberFieldValue(countedQty) }, { expand: 'category' })
  await createStockMovement({ productId: record.id, movementType: 'adjustment', quantity: Math.abs(delta), previousQuantity: previousQty, newQuantity: countedQty, referenceType: 'physical_count', notes: `${reason}${note ? ` (${note})` : ''}` })
  await createLog({ action: 'Inventory Adjustment', detail: `Adjusted "${record.name}" from ${previousQty} to ${countedQty} (${reason})${note ? ` - ${note}` : ''}` })
  res.json(toProduct(updated))
}))

app.get('/api/system/import-status', asyncRoute(async (_req, res) => {
  const reportsDir = path.resolve(__dirname, '..', 'migration_reports')
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(reportsDir, name), 'utf8')) } catch { return null }
  }
  const readTail = (name) => {
    try {
      const content = fs.readFileSync(path.join(reportsDir, name), 'utf8').trim()
      return content ? content.split(/\r?\n/).slice(-20) : []
    } catch { return [] }
  }
  res.json({ dryRun: readJson('legacy-import-dry-run.json'), result: readJson('legacy-import-result.json'), progress: readTail('legacy-import.log'), errors: readTail('legacy-import-error.log') })
}))

app.get('/api/system/backups', asyncRoute(async (_req, res) => {
  await pbCollection('products')
  res.json(await pb.backups.getFullList())
}))

function automaticBackupName(date = new Date()) {
  return `nexa_auto_${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.zip`
}

async function pruneAutomaticBackups() {
  const backups = await pb.backups.getFullList()
  const automatic = backups
    .filter((backup) => String(backup.key || backup.name || '').startsWith('nexa_auto_'))
    .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))
  for (const backup of automatic.slice(AUTO_BACKUP_RETENTION)) {
    await pb.backups.delete(backup.key || backup.name)
  }
  return automatic.slice(0, AUTO_BACKUP_RETENTION)
}

async function runAutomaticBackup() {
  if (!AUTO_BACKUP_ENABLED) return { enabled: false, created: false }
  await pbCollection('products')
  const backups = await pb.backups.getFullList()
  const latestAuto = backups
    .filter((backup) => String(backup.key || backup.name || '').startsWith('nexa_auto_'))
    .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))[0]
  if (latestAuto && Date.now() - new Date(latestAuto.modified || 0).getTime() < AUTO_BACKUP_INTERVAL_MS) {
    await pruneAutomaticBackups()
    return { enabled: true, created: false, latest: latestAuto.key || latestAuto.name }
  }
  const name = automaticBackupName()
  await pb.backups.create(name)
  await pruneAutomaticBackups()
  return { enabled: true, created: true, latest: name }
}

app.get('/api/system/backup-policy', asyncRoute(async (_req, res) => {
  const backups = await pb.backups.getFullList()
  const automatic = backups.filter((backup) => String(backup.key || backup.name || '').startsWith('nexa_auto_'))
  res.json({ enabled: AUTO_BACKUP_ENABLED, retention: AUTO_BACKUP_RETENTION, intervalHours: Math.round(AUTO_BACKUP_INTERVAL_MS / 3600000), automaticBackups: automatic.length, latest: automatic.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))[0] || null })
}))

app.post('/api/system/backups/automatic', asyncRoute(async (_req, res) => {
  res.status(201).json(await runAutomaticBackup())
}))

app.get('/api/system/maintenance-report', asyncRoute(async (_req, res) => {
  const [products, saleItems] = await Promise.all([
    (await pbCollection('products')).getFullList({ fields: 'id,name,barcode,price,quantity,category', requestKey: null }),
    (await pbCollection('sale_items')).getFullList({ fields: 'id,product_id', requestKey: null }).catch(() => []),
  ])
  const barcodeGroups = new Map()
  for (const product of products) {
    const barcode = String(product.barcode || '').trim().toLowerCase()
    if (!barcode) continue
    barcodeGroups.set(barcode, [...(barcodeGroups.get(barcode) || []), product])
  }
  const productIds = new Set(products.map((product) => product.id))
  const duplicateBarcodes = [...barcodeGroups.entries()]
    .filter(([, records]) => records.length > 1)
    .map(([barcode, records]) => ({ barcode, count: records.length, products: records.map((record) => record.name) }))
  const invalidPrices = products.filter((product) => !Number.isFinite(Number(product.price)) || Number(product.price) <= 0)
  const invalidStock = products.filter((product) => !Number.isFinite(Number(product.quantity)) || Number(product.quantity) < 0)
  const uncategorized = products.filter((product) => !product.category)
  const orphanSaleItems = saleItems.filter((item) => {
    const productId = Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
    return productId && !productIds.has(productId)
  })
  res.json({ checkedAt: new Date().toISOString(), products: products.length, duplicateBarcodes, invalidPrices: invalidPrices.map((item) => ({ id: item.id, name: item.name })), invalidStock: invalidStock.map((item) => ({ id: item.id, name: item.name })), uncategorized: uncategorized.map((item) => ({ id: item.id, name: item.name })), orphanSaleItems: orphanSaleItems.length })
}))

app.post('/api/system/backups', asyncRoute(async (_req, res) => {
  await pbCollection('products')
  const name = `nexa_backup_${Date.now()}.zip`
  await pb.backups.create(name)
  res.status(201).json({ name })
}))

app.post('/api/system/backups/:name/restore', asyncRoute(async (req, res) => {
  if (req.body?.confirmation !== `RESTORE ${req.params.name}`) return res.status(400).json({ error: 'Restore confirmation did not match.' })
  await pbCollection('products')
  await pb.backups.restore(req.params.name)
  res.json({ restored: req.params.name })
}))

app.use(express.static(DIST_DIR))

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next()
    return
  }

  res.sendFile(INDEX_HTML, (error) => {
    if (error) next(error)
  })
})

app.use((error, _req, res, next) => {
  void next
  const status = error.status || 500
  if (status >= 500) console.error(error)
  res.status(status).json({
    error: error.message || 'Server error',
    details: error.details,
  })
})

export { app }

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Admin API listening on http://localhost:${PORT}`)
    console.log(`For LAN testing, open http://<this-computer-ip>:${PORT}`)
    if (AUTO_BACKUP_ENABLED) {
      const initialBackupTimer = setTimeout(() => runAutomaticBackup().catch((error) => console.error('Automatic backup failed:', error.message)), 30000)
      initialBackupTimer.unref?.()
      const backupTimer = setInterval(() => runAutomaticBackup().catch((error) => console.error('Automatic backup failed:', error.message)), AUTO_BACKUP_INTERVAL_MS)
      backupTimer.unref?.()
    }
  })
}

export default app
