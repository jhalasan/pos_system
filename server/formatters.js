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
  const qty = Number(input.qty)
  const lowStock = Number(input.lowStock)
  const price = Number(input.price)
  return {
    name: String(input.name || '').trim(),
    barcode: String(input.barcode || '').trim(),
    category: categoryId || '',
    quantity: numberFieldValue(qty),
    base_unit: input.unit || 'Piece',
    min_stock: Number.isFinite(lowStock) ? Math.max(0, lowStock) : 0,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
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

  return {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    shift: input.shift || 'Morning',
    status: input.status || 'active',
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
