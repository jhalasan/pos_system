export function deriveStatus(product) {
  const qty = Number(product.qty ?? product.quantity) || 0
  const lowStock = Number(product.lowStock ?? product.min_stock ?? 10)
  if (qty <= 0) return 'out-of-stock'
  if (qty <= 5) return 'critical'
  if (qty <= lowStock) return 'low'
  return 'in-stock'
}

function firstFileValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function fileProxyUrl(record, filename, query = '') {
  if (!filename) return ''
  const collection = record.collectionId || record.collectionName
  if (!collection || !record.id) return ''
  const suffix = query ? `?${query}` : ''
  return `/api/pocketbase/files/${encodeURIComponent(collection)}/${encodeURIComponent(record.id)}/${encodeURIComponent(filename)}${suffix}`
}

function productImageUrl(record) {
  const filename = firstFileValue(record.product_img)
  return fileProxyUrl(record, filename)
}

function profileImageUrl(record) {
  const filename = firstFileValue(record.profile_img)
  return fileProxyUrl(record, filename, 'thumb=100x100')
}

function firstRelationValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function numberFieldValue(value) {
  const number = Number(value)
  return String(Number.isFinite(number) ? Math.max(0, number) : 0)
}

function booleanFieldValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'null', 'undefined', ''].includes(normalized)) return false
  }
  return false
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

export function toProduct(record) {
  const expandedCategory = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category

  return {
    id: record.id,
    sku: record.id,
    name: record.name || '',
    barcode: record.barcode || '',
    category: expandedCategory?.name || firstRelationValue(record.category) || '',
    categoryId: firstRelationValue(record.category) || '',
    qty: Number(record.quantity) || 0,
    unit: record.base_unit || 'Piece',
    purchaseUnit: record.purchase_unit || record.purchaseUnit || 'Box',
    conversionQuantity: Number(record.conversion_quantity ?? record.conversionQuantity ?? 1) || 1,
    initialStock: Number(record.initial_stock ?? record.initialStock ?? 0) || 0,
    stockUnit: record.stock_unit || record.stockUnit || '',
    lowStock: Number(record.min_stock) || 0,
    price: Number(record.price) || 0,
    cost: Number(record.cost) || 0,
    profitMargin: Number(record.profitMargin) || 0,
    hasMultipleUnits: booleanFieldValue(record.has_multiple_units ?? record.hasMultipleUnits),
    image: firstFileValue(record.product_img) || '',
    imageUrl: productImageUrl(record),
    tiers: [{ label: 'Retail', price: Number(record.price) || 0 }],
    sellingUnits: parseSellingUnits(record.selling_units ?? record.sellingUnits),
    status: deriveStatus(record),
    soldUnits: Number(record.soldUnits ?? record.sold_units ?? 0),
    lifecycleStatus: record.lifecycle_status || 'active',
  }
}

export function productPayload(input, categoryId) {
  const qty = Number(input.qty)
  const initialStock = Number(input.initialStock ?? input.qty)
  const lowStock = Number(input.lowStock)
  const price = Number(input.price)
  const cost = Number(input.cost)
  const profitMargin = Number(input.profitMargin)
  const conversionQuantity = Number(input.conversionQuantity ?? input.conversion_quantity ?? 1)
  const hasMultipleUnits = booleanFieldValue(input.hasMultipleUnits ?? input.has_multiple_units)
  return {
    name: String(input.name || '').trim(),
    barcode: String(input.barcode || '').trim(),
    category: categoryId || '',
    quantity: numberFieldValue(qty),
    initial_stock: Number.isFinite(initialStock) ? Math.max(0, initialStock) : 0,
    stock_unit: String(input.stockUnit || input.stock_unit || '').trim(),
    purchase_unit: String(input.purchaseUnit || input.purchase_unit || '').trim(),
    conversion_quantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    base_unit: input.unit || 'Piece',
    min_stock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
    cost: Number.isFinite(cost) ? Math.max(0, cost) : 0,
    profitMargin: Number.isFinite(profitMargin) ? Math.max(0, profitMargin) : 0,
    has_multiple_units: hasMultipleUnits,
    selling_units: parseSellingUnits(input.sellingUnits || input.selling_units),
    lifecycle_status: ['inactive', 'archived'].includes(input.lifecycleStatus || input.lifecycle_status) ? (input.lifecycleStatus || input.lifecycle_status) : 'active',
  }
}

export function productFormData(input, categoryId, file) {
  const payload = productPayload(input, categoryId)
  if (!file) return payload

  return {
    ...payload,
    product_img: new File([file.buffer], file.originalname, { type: file.mimetype }),
  }
}

export function toCashier(record, sales = 0) {
  const email = record.email || ''
  const barcode = record.void_barcode || ''
  const role = record.role === 'manager' || (record.role === 'cashier' && String(barcode).startsWith('92'))
    ? 'manager'
    : (record.role || 'cashier')

  return {
    id: record.id,
    cashierId: record.id,
    name: record.name || email.split('@')[0] || (role === 'manager' ? 'Manager' : 'Cashier'),
    email,
    role,
    shift: record.shift || 'Morning',
    status: record.status || 'active',
    quickLoginEnabled: Boolean(record.quick_login_enabled),
    cashierBarcode: barcode,
    image: firstFileValue(record.profile_img) || '',
    imageUrl: profileImageUrl(record),
    sales: Number(sales) || 0,
  }
}

export function toUserAccount(record) {
  const email = record.email || ''
  const name = record.name || email.split('@')[0] || 'User'

  return {
    id: record.id,
    name,
    email,
    role: record.role || '',
    status: record.status || 'active',
    quickLoginEnabled: Boolean(record.quick_login_enabled),
    authorizationBarcode: record.void_barcode || '',
  }
}

export function cashierPayload(input = {}) {
  const password = input.password || process.env.DEFAULT_CASHIER_PASSWORD || 'cashier123'
  const requestedRole = String(input.role || '').trim() === 'manager' ? 'manager' : 'cashier'
  const barcode = String(input.cashierBarcode || input.void_barcode || '').trim()
  const staffBarcode = requestedRole === 'manager' && barcode && !barcode.startsWith('92')
    ? `92${barcode}`
    : barcode

  return {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    shift: input.shift || 'Morning',
    status: input.status || 'active',
    void_barcode: staffBarcode,
    password,
    passwordConfirm: password,
    role: 'cashier',
    emailVisibility: true,
  }
}

export function cashierFormData(input = {}, file) {
  const payload = cashierPayload(input)
  if (!file) return payload

  return {
    ...payload,
    profile_img: new File([file.buffer], file.originalname, { type: file.mimetype }),
  }
}

export function toActivityLog(record) {
  const user = Array.isArray(record.expand?.user_id)
    ? record.expand.user_id[0]
    : record.expand?.user_id

  return {
    id: record.id,
    user: user?.email || record.user_id || 'System',
    userType: user?.role === 'cashier' ? 'Cashier' : 'Admin',
    action: record.action_type || '',
    detail: record.description || '',
    time: record.timestamp || record.created || '',
  }
}

export function activityLogPayload(input) {
  return {
    user_id: input.userId || '',
    action_type: input.action || 'Activity',
    description: input.detail || '',
    timestamp: input.time || new Date().toISOString(),
  }
}
