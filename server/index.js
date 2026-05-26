import express from 'express'
import cors from 'cors'
import multer from 'multer'
import 'dotenv/config'
import {
  authenticateAdminUser,
  authenticateRoleUser,
  pb,
  pbCollection,
} from './pocketbase.js'
import {
  activityLogPayload,
  cashierPayload,
  deriveStatus,
  productPayload,
  productFormData,
  toActivityLog,
  toCashier,
  toProduct,
  toUserAccount,
} from './formatters.js'

const app = express()
const PORT = Number(process.env.API_PORT || 3001)
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
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
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }
    callback(new Error(`Origin ${origin} is not allowed by CORS.`))
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

async function createLog(log) {
  try {
    await (await pbCollection('activity_logs')).create(activityLogPayload(log))
  } catch (error) {
    console.warn(`Could not write activity log: ${error.message}`)
  }
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
  res.json({ ok: true, user })
}))

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

app.get('/api/products', asyncRoute(async (_req, res) => {
  const records = await listRecords('products', '?sort=name&expand=category&perPage=500')
  res.json(records.map(toProduct))
}))

app.get('/api/cashier/products', asyncRoute(async (_req, res) => {
  const records = await listRecords('products', '?sort=name&expand=category&perPage=500')
  res.json(records.map(toProduct))
}))

app.get('/api/cashier/products/barcode/:barcode', asyncRoute(async (req, res) => {
  const barcode = String(req.params.barcode || '').trim()
  const record = await (await pbCollection('products')).getFirstListItem(
    pb.filter('barcode = {:barcode}', { barcode }),
    { expand: 'category' },
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (!record) return res.status(404).json({ error: `No product found for barcode "${barcode}".` })

  const product = toProduct(record)
  if (product.qty <= 0) return res.status(409).json({ error: `"${product.name}" is out of stock.` })
  res.json(product)
}))

app.post('/api/cashier/authorize-void', asyncRoute(async (req, res) => {
  const code = String(req.body?.code || '').trim()
  if (!code) return res.status(400).json({ error: 'Manager barcode is required.' })

  const manager = await (await pbCollection('users')).getFirstListItem(
    pb.filter('void_barcode = {:code} && role = "admin"', { code }),
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (!manager) return res.status(403).json({ error: 'Manager barcode is not valid.' })
  res.json({ ok: true })
}))

app.get('/api/cashier/sales', asyncRoute(async (req, res) => {
  const cashierId = String(req.query?.cashierId || '').trim()
  const search = String(req.query?.q || '').trim().toLowerCase()
  if (!cashierId) return res.status(400).json({ error: 'Cashier is required.' })

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sales = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    filter: pb.filter('cashier_id = {:cashierId} && status != "voided"', { cashierId }),
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
    const items = await saleItems.getFullList({
      sort: 'created',
      filter: pb.filter('sale_id = {:saleId}', { saleId: sale.id }),
      expand: 'product_id',
    })

    history.push({
      id: sale.id,
      transactionNo: sale.transaction_no || sale.id,
      totalAmount: Number(sale.total_amount) || 0,
      paymentMethod: sale.payment_method || '',
      status: sale.status || 'completed',
      createdAt: sale.created_at || sale.created,
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

app.get('/api/cashier/next-transaction-number', asyncRoute(async (_req, res) => {
  res.json({ transactionNo: await nextTransactionNumber() })
}))

app.post('/api/cashier/sales', asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const cashierId = String(req.body?.cashierId || '').trim()
  const paymentMethod = req.body?.paymentMethod === 'gcash' ? 'gcash' : 'cash'
  const refNumber = String(req.body?.refNumber || '').trim()
  const totalAmount = Number(req.body?.totalAmount) || 0
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
    if ((Number(product.quantity) || 0) < quantity) {
      return res.status(409).json({ error: `"${product.name}" has only ${product.quantity || 0} item(s) left.` })
    }
    productRecords.push({ product, item, quantity })
  }

  const sale = await sales.create({
    transaction_no: transactionNo,
    cashier_id: cashierId,
    total_amount: totalAmount,
    payment_method: paymentMethod,
    ref_number: refNumber,
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  for (const { product, item, quantity } of productRecords) {
    await saleItems.create({
      sale_id: sale.id,
      product_id: product.id,
      quantity_sold: quantity,
      price_at_sale: Number(item.price) || Number(product.price) || 0,
    })
    await products.update(product.id, {
      quantity: Math.max(0, (Number(product.quantity) || 0) - quantity),
    })
  }

  await createLog({
    userId: cashierId,
    action: 'Sale',
    detail: `Completed transaction ${transactionNo} - PHP ${totalAmount.toFixed(2)}`,
  })

  res.status(201).json({ id: sale.id, transactionNo, totalAmount })
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
  await (await pbCollection('products')).delete(req.params.id)
  await createLog({ action: 'Product', detail: `Deleted product ${req.params.id}` })
  res.status(204).end()
}))

app.post('/api/inventory/scan', asyncRoute(async (req, res) => {
  const barcode = String(req.body.barcode || '').trim()
  const qty = Number(req.body.qty) || 1
  if (!barcode) return res.status(400).json({ error: 'Barcode is required.' })

  const record = await (await pbCollection('products')).getFirstListItem(
    pb.filter('barcode = {:barcode}', { barcode }),
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })
  if (!record) return res.status(404).json({ error: `No product found for barcode "${barcode}".` })

  const nextQty = (Number(record.quantity) || 0) + qty
  const updated = await (await pbCollection('products')).update(record.id, { quantity: nextQty }, { expand: 'category' })
  await createLog({ action: 'Stock Update', detail: `Added ${qty} unit(s) to "${record.name}"` })
  res.json(toProduct(updated))
}))

app.get('/api/cashiers', asyncRoute(async (_req, res) => {
  const records = await listRecords('users', '?filter=role="cashier"&sort=email&perPage=500')
  const salesByCashier = await getSalesByCashier()
  res.json(records.map((record) => toCashier(record, salesByCashier.get(record.id))))
}))

app.post('/api/cashiers', asyncRoute(async (req, res) => {
  const payload = cashierPayload(req.body)
  if (!payload.name || !payload.email) {
    return res.status(400).json({ error: 'Name and email are required.' })
  }

  const created = await (await pbCollection('users')).create(payload)
  await createLog({ action: 'Cashier', detail: `Added cashier "${payload.email}"` })
  res.status(201).json(toCashier(created))
}))

app.patch('/api/cashiers/:id', asyncRoute(async (req, res) => {
  const payload = cashierPayload(req.body)
  delete payload.password
  delete payload.passwordConfirm
  const updated = await (await pbCollection('users')).update(req.params.id, payload)
  await createLog({ action: 'Cashier', detail: `Updated cashier "${payload.email}"` })
  res.json(toCashier(updated))
}))

app.get('/api/settings/cashiers', asyncRoute(async (_req, res) => {
  const records = await listRecords('users', '?filter=role="cashier"&sort=email&perPage=500')
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
  })
  await createLog({
    action: 'Settings',
    detail: `${enabled ? 'Enabled' : 'Disabled'} admin quick login for "${updated.email}"`,
  })
  res.json(toUserAccount(updated))
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

app.get('/api/dashboard', asyncRoute(async (_req, res) => {
  const products = (await listRecords('products', '?expand=category&perPage=500')).map(toProduct)
  const sales = await listRecords('sales', '?filter=status!="voided"&perPage=500')
  const saleItems = await listRecords('sale_items', '?expand=product_id&perPage=500')
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const completedSales = sales.filter((sale) => (sale.status || 'completed') !== 'voided')
  const dailySales = completedSales
    .filter((sale) => new Date(sale.created_at || sale.created) >= todayStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const monthlySales = completedSales
    .filter((sale) => new Date(sale.created_at || sale.created) >= monthStart)
    .reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)
  const totalRevenue = completedSales.reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0)

  const criticalAlerts = products
    .filter((product) => deriveStatus(product) === 'critical')
    .slice(0, 5)
    .map((product) => ({ name: product.name, left: product.qty }))

  const productSales = new Map()
  for (const item of saleItems) {
    const productId = Array.isArray(item.product_id) ? item.product_id[0] : item.product_id
    if (!productId) continue
    const expandedProduct = Array.isArray(item.expand?.product_id)
      ? item.expand.product_id[0]
      : item.expand?.product_id
    const current = productSales.get(productId) || {
      name: expandedProduct?.name || productId,
      category: '',
      units: 0,
    }
    current.units += Number(item.quantity_sold) || 0
    productSales.set(productId, current)
  }

  const topProducts = [...productSales.values()]
    .filter((product) => product.units > 0)
    .sort((a, b) => b.units - a.units)
    .slice(0, 5)

  res.json({
    stats: {
      dailySales,
      dailySalesTrend: 0,
      monthlySales,
      monthlySalesTrend: 0,
      totalRevenue,
      totalRevenueTrend: 0,
      criticalStock: criticalAlerts.length,
    },
    criticalAlerts,
    productInOut: [
      { label: 'Stock In', value: 0, color: '#4f46e5' },
      { label: 'Stock Out', value: 0, color: '#16a34a' },
      { label: 'Adjustments', value: 0, color: '#f59e0b' },
    ],
    topProducts,
    hourlySales: [],
    monthlySales: [],
  })
}))

app.use((error, _req, res, next) => {
  void next
  console.error(error)
  res.status(error.status || 500).json({
    error: error.message || 'Server error',
    details: error.details,
  })
})

app.listen(PORT, () => {
  console.log(`Admin API listening on http://localhost:${PORT}`)
})
