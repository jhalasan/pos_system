import 'dotenv/config'
import PocketBase from 'pocketbase'

const pbUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
const email = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD

if (!email || !password) {
  throw new Error('Set POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in .env first.')
}

const pb = new PocketBase(pbUrl)
pb.autoCancellation(false)

async function authAsSuperuser() {
  try {
    await pb.collection('_superusers').authWithPassword(email, password)
  } catch (error) {
    if (error.status !== 404) throw error
    await pb.collection('_admins').authWithPassword(email, password)
  }
}

async function firstOrCreate(collectionName, filter, payload) {
  const existing = await pb.collection(collectionName).getFirstListItem(filter, {
    requestKey: null,
  }).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (existing) return existing
  return pb.collection(collectionName).create(payload, { requestKey: null })
}

async function firstOrUpdate(collectionName, filter, payload) {
  const existing = await pb.collection(collectionName).getFirstListItem(filter, {
    requestKey: null,
  }).catch((error) => {
    if (error.status === 404) return null
    throw error
  })

  if (!existing) {
    return pb.collection(collectionName).create(payload, { requestKey: null })
  }

  return pb.collection(collectionName).update(existing.id, payload, { requestKey: null })
}

function daysAgo(days, hour = 10, minute = 0) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

await authAsSuperuser()

const categories = {}
for (const name of [
  'Beverages (sample)',
  'Snacks (sample)',
  'Household (sample)',
]) {
  categories[name] = await firstOrCreate(
    'categories',
    pb.filter('name = {:name}', { name }),
    { name },
  )
}

const products = []
for (const product of [
  {
    barcode: 'SAMPLE-480000000001',
    name: 'Iced Coffee 250ml (sample)',
    category: categories['Beverages (sample)'].id,
    base_unit: 'Bottle',
    price: 45,
    quantity: 36,
    min_stock: 12,
  },
  {
    barcode: 'SAMPLE-480000000002',
    name: 'Potato Chips 60g (sample)',
    category: categories['Snacks (sample)'].id,
    base_unit: 'Pack',
    price: 38,
    quantity: 24,
    min_stock: 10,
  },
  {
    barcode: 'SAMPLE-480000000003',
    name: 'Dish Soap 500ml (sample)',
    category: categories['Household (sample)'].id,
    base_unit: 'Bottle',
    price: 89,
    quantity: 8,
    min_stock: 10,
  },
  {
    barcode: 'SAMPLE-480000000004',
    name: 'Instant Noodles Beef (sample)',
    category: categories['Snacks (sample)'].id,
    base_unit: 'Pack',
    price: 18,
    quantity: 4,
    min_stock: 15,
  },
]) {
  products.push(await firstOrUpdate(
    'products',
    pb.filter('barcode = {:barcode}', { barcode: product.barcode }),
    product,
  ))
}

const admin = await pb.collection('users').getFirstListItem(
  'role = "admin"',
  { requestKey: null },
).catch(() => null)

const cashier = await firstOrUpdate(
  'users',
  pb.filter('email = {:email}', { email: 'cashier.sample@nexapos.local' }),
  {
    email: 'cashier.sample@nexapos.local',
    password: 'CashierSample123',
    passwordConfirm: 'CashierSample123',
    role: 'cashier',
    name: 'Cashier One (sample)',
    shift: 'Morning',
    status: 'active',
    verified: true,
    quick_login_enabled: true,
  },
)

const saleTemplates = [
  {
    transaction_no: '202606160001',
    total_amount: 121,
    payment_method: 'cash',
    created_at: daysAgo(0, 9, 15),
    items: [
      { product: products[0], quantity_sold: 1, price_at_sale: 45 },
      { product: products[1], quantity_sold: 2, price_at_sale: 38 },
    ],
  },
  {
    transaction_no: '202606160002',
    total_amount: 125,
    payment_method: 'gcash',
    ref_number: 'GCASH-SAMPLE-1002',
    created_at: daysAgo(1, 15, 30),
    items: [
      { product: products[2], quantity_sold: 1, price_at_sale: 89 },
      { product: products[3], quantity_sold: 2, price_at_sale: 18 },
    ],
  },
]

for (const saleTemplate of saleTemplates) {
  const sale = await firstOrUpdate(
    'sales',
    pb.filter('transaction_no = {:transactionNo}', {
      transactionNo: saleTemplate.transaction_no,
    }),
    {
      transaction_no: saleTemplate.transaction_no,
      cashier_id: cashier.id,
      total_amount: saleTemplate.total_amount,
      payment_method: saleTemplate.payment_method,
      ref_number: saleTemplate.ref_number || '',
      status: 'completed',
      created_at: saleTemplate.created_at,
    },
  )

  for (const item of saleTemplate.items) {
    await firstOrUpdate(
      'sale_items',
      pb.filter('sale_id = {:saleId} && product_id = {:productId}', {
        saleId: sale.id,
        productId: item.product.id,
      }),
      {
        sale_id: sale.id,
        product_id: item.product.id,
        quantity_sold: item.quantity_sold,
        price_at_sale: item.price_at_sale,
      },
    )
  }
}

await firstOrUpdate(
  'authorization_barcodes',
  pb.filter('code = {:code}', { code: '990000000001' }),
  {
    code: '990000000001',
    label: 'Manager void approval (sample)',
    purpose: 'void_discount',
    status: 'active',
    generated_by: admin?.id || '',
  },
)

for (const log of [
  {
    action_type: 'Seed Sample Data',
    description: 'Created sample products, cashier, and sales (sample).',
    timestamp: daysAgo(0, 9, 0),
  },
  {
    action_type: 'Inventory Review',
    description: 'Checked low stock sample items (sample).',
    timestamp: daysAgo(0, 10, 30),
  },
]) {
  await firstOrCreate(
    'activity_logs',
    pb.filter('description = {:description}', { description: log.description }),
    {
      user_id: admin?.id || '',
      ...log,
    },
  )
}

console.log(`Sample data seeded in ${pbUrl}`)
console.log('Sample labels/names include "(sample)".')
