import PocketBase from 'pocketbase'

const baseUrl = import.meta.env.VITE_POCKETBASE_URL

function requireBaseUrl() {
  if (!baseUrl) throw new Error('VITE_POCKETBASE_URL is required for desktop admin access.')
}

export const pb = new PocketBase(baseUrl || 'http://127.0.0.1:8090')
pb.autoCancellation(false)

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

function deriveStatus(product) {
  const qty = Number(product.qty ?? product.quantity) || 0
  const lowStock = Number(product.lowStock ?? product.min_stock ?? 10)
  if (qty <= 5) return 'critical'
  if (qty <= lowStock) return 'low'
  return 'in-stock'
}

function fileUrl(record, filename) {
  if (!filename) return ''
  return pb.files.getURL(record, filename)
}

function toProduct(record) {
  const category = Array.isArray(record.expand?.category)
    ? record.expand.category[0]
    : record.expand?.category
  const image = Array.isArray(record.product_img) ? record.product_img[0] : record.product_img

  return {
    id: record.id,
    sku: record.id,
    name: record.name || '',
    barcode: record.barcode || '',
    category: category?.name || firstRelation(record.category) || '',
    categoryId: firstRelation(record.category) || '',
    qty: Number(record.quantity) || 0,
    unit: record.base_unit || 'Piece',
    lowStock: Number(record.min_stock) || 0,
    price: Number(record.price) || 0,
    image: image || '',
    imageUrl: fileUrl(record, image),
    tiers: [{ label: 'Retail', price: Number(record.price) || 0 }],
    status: deriveStatus(record),
  }
}

const emptyDashboard = {
  stats: {
    dailySales: 0,
    dailySalesTrend: 0,
    monthlySales: 0,
    monthlySalesTrend: 0,
    totalRevenue: 0,
    totalRevenueTrend: 0,
    criticalStock: 0,
  },
  criticalAlerts: [],
  productInOut: [
    { label: 'Stock In', value: 0, color: '#16a34a' },
    { label: 'Stock Out', value: 0, color: '#ef4444' },
  ],
  topProducts: [],
  hourlySales: [],
  monthlySales: [],
}

async function getOrCreateCategoryId(name) {
  const categoryName = String(name || '').trim()
  if (!categoryName) return ''

  const existing = await pb.collection('categories').getFirstListItem(
    pb.filter('name = {:name}', { name: categoryName }),
    { requestKey: null },
  ).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (existing) return existing.id
  return (await pb.collection('categories').create({ name: categoryName }, { requestKey: null })).id
}

async function productPayload(data) {
  return {
    name: String(data.name || '').trim(),
    barcode: String(data.barcode || '').trim(),
    category: await getOrCreateCategoryId(data.category),
    quantity: Number(data.qty) || 0,
    base_unit: data.unit || 'Piece',
    min_stock: Number(data.lowStock) || 0,
    price: Number(data.price) || 0,
  }
}

async function productBody(data) {
  const payload = await productPayload(data)
  if (!data.imageFile) return payload

  const formData = new FormData()
  for (const [key, value] of Object.entries(payload)) {
    formData.append(key, value ?? '')
  }
  formData.append('product_img', data.imageFile)
  return formData
}

function assertAdmin() {
  if (!pb.authStore.isValid || pb.authStore.record?.role !== 'admin') {
    throw new Error('Admin login is required.')
  }
}

export const desktopAdminApi = {
  async login(email, password) {
    requireBaseUrl()
    const auth = await pb.collection('users').authWithPassword(email, password)
    if (auth.record?.role !== 'admin') {
      pb.authStore.clear()
      throw new Error('Only admin accounts can access this area.')
    }
    if (auth.record?.status === 'inactive') {
      pb.authStore.clear()
      throw new Error('This account is inactive.')
    }
    return { user: auth.record }
  },

  logout() {
    pb.authStore.clear()
  },

  async adminQuickLoginAccounts() {
    requireBaseUrl()
    return pb.collection('users').getFullList({
      filter: 'role = "admin" && quick_login = true && status = "active"',
      fields: 'id,name,email,role,status',
      sort: 'name',
      requestKey: null,
    }).catch(() => [])
  },

  async products() {
    assertAdmin()
    const records = await pb.collection('products').getFullList({
      sort: 'name',
      expand: 'category',
      requestKey: null,
    })
    return records.map(toProduct)
  },

  async createProduct(data) {
    assertAdmin()
    const created = await pb.collection('products').create(await productBody(data), {
      expand: 'category',
      requestKey: null,
    })
    return toProduct(created)
  },

  async updateProduct(id, data) {
    assertAdmin()
    const updated = await pb.collection('products').update(id, await productBody(data), {
      expand: 'category',
      requestKey: null,
    })
    return toProduct(updated)
  },

  async deleteProduct(id) {
    assertAdmin()
    await pb.collection('products').delete(id, { requestKey: null })
    return null
  },

  async scanInventory({ barcode, qty = 1 }) {
    assertAdmin()
    const product = await pb.collection('products').getFirstListItem(
      pb.filter('barcode = {:barcode}', { barcode: String(barcode || '').trim() }),
      { expand: 'category', requestKey: null },
    )
    const updated = await pb.collection('products').update(product.id, {
      quantity: (Number(product.quantity) || 0) + Math.max(1, Number(qty) || 1),
    }, {
      expand: 'category',
      requestKey: null,
    })
    return toProduct(updated)
  },

  async fsnInventory() {
    const products = await this.products()
    return products.map((product) => ({
      ...product,
      fsn: 'Non-moving',
      fsnReason: 'Desktop local mode has no movement analysis yet',
      units90: 0,
      averageMonthlyUnits: 0,
    }))
  },

  async nextProductBarcode() {
    return { barcode: `29${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 10)}` }
  },

  async dashboard() {
    const products = await this.products()
    const criticalAlerts = products
      .filter((product) => product.status === 'critical')
      .slice(0, 8)
      .map((product) => ({ name: product.name, left: product.qty }))

    return {
      ...emptyDashboard,
      stats: {
        ...emptyDashboard.stats,
        criticalStock: criticalAlerts.length,
      },
      criticalAlerts,
      productInOut: [
        {
          label: 'Stock In',
          value: products.reduce((sum, product) => sum + Number(product.qty || 0), 0),
          color: '#16a34a',
        },
        { label: 'Stock Out', value: 0, color: '#ef4444' },
      ],
    }
  },
  latestAuthorizationBarcode: async () => null,
  authorizationBarcodes: async () => [],
  updateAuthorizationBarcodeStatus: async () => null,
  deleteAuthorizationBarcode: async () => null,
  cashiers: async () => [],
  createCashier: async () => { throw new Error('Cashier management is not available in desktop local mode yet.') },
  updateCashier: async () => { throw new Error('Cashier management is not available in desktop local mode yet.') },
  deleteCashier: async () => null,
  activityLogs: async () => [],
  settingsAdmins: async () => [],
  updateAdminQuickLogin: async () => null,
  updateAdminAuthorizationBarcode: async () => null,
  generateAuthorizationBarcode: async () => null,
  settingsCashiers: async () => [],
  updateCashierQuickLogin: async () => null,
}
