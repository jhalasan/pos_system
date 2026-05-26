const PB_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'

export function deriveStatus(product) {
  const qty = Number(product.qty ?? product.quantity) || 0
  const lowStock = Number(product.lowStock ?? product.min_stock ?? 10)
  if (qty <= 5) return 'critical'
  if (qty <= lowStock) return 'low'
  return 'in-stock'
}

function firstFileValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function productImageUrl(record) {
  const filename = firstFileValue(record.product_img)
  if (!filename) return ''
  return `${PB_URL}/api/files/products/${record.id}/${encodeURIComponent(filename)}`
}

function firstRelationValue(value) {
  return Array.isArray(value) ? value[0] : value
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
    lowStock: Number(record.min_stock) || 0,
    price: Number(record.price) || 0,
    image: firstFileValue(record.product_img) || '',
    imageUrl: productImageUrl(record),
    tiers: [{ label: 'Retail', price: Number(record.price) || 0 }],
    status: deriveStatus(record),
    soldUnits: Number(record.soldUnits ?? record.sold_units ?? 0),
  }
}

export function productPayload(input, categoryId) {
  return {
    name: String(input.name || '').trim(),
    barcode: String(input.barcode || '').trim(),
    category: categoryId || '',
    quantity: Number(input.qty) || 0,
    base_unit: input.unit || 'Piece',
    min_stock: Number(input.lowStock) || 0,
    price: Number(input.price) || 0,
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

  return {
    id: record.id,
    cashierId: record.id,
    name: record.name || email.split('@')[0] || 'Cashier',
    email,
    shift: record.shift || 'Morning',
    status: record.status || 'active',
    quickLoginEnabled: Boolean(record.quick_login_enabled),
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
  }
}

export function cashierPayload(input) {
  const password = input.password || process.env.DEFAULT_CASHIER_PASSWORD || 'cashier123'

  return {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    shift: input.shift || 'Morning',
    status: input.status || 'active',
    password,
    passwordConfirm: password,
    role: 'cashier',
    verified: input.status !== 'inactive',
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
