import PocketBase from 'pocketbase'
import 'dotenv/config'

const PB_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
const PB_SUPERUSER_EMAIL = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
const PB_SUPERUSER_PASSWORD = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD

export const pb = new PocketBase(PB_URL)
pb.autoCancellation(false)

let authPromise = null

export async function ensurePocketBaseAuth() {
  if (!PB_SUPERUSER_EMAIL || !PB_SUPERUSER_PASSWORD) return
  if (pb.authStore.isValid) return

  authPromise ||= pb.collection('_superusers').authWithPassword(
    PB_SUPERUSER_EMAIL,
    PB_SUPERUSER_PASSWORD,
  )

  try {
    await authPromise
  } finally {
    authPromise = null
  }
}

export async function pbCollection(name) {
  await ensurePocketBaseAuth()
  return pb.collection(name)
}

export async function authenticateAdminUser(email, password) {
  return authenticateRoleUser(email, password, 'admin')
}

export async function authenticateRoleUser(email, password, requiredRole) {
  const authClient = new PocketBase(PB_URL)
  authClient.autoCancellation(false)
  const authData = await authClient.collection('users').authWithPassword(email, password)
  const record = authData.record

  if (record?.role !== requiredRole) {
    const error = new Error(`Only ${requiredRole} accounts can access this area.`)
    error.status = 403
    throw error
  }

  if (record?.status === 'inactive') {
    const error = new Error('This account is inactive.')
    error.status = 403
    throw error
  }

  if (!record.status) {
    await ensurePocketBaseAuth()
    await pb.collection('users').update(record.id, { status: 'active' })
    record.status = 'active'
  }

  return {
    id: record.id,
    email: record.email,
    name: record.name || record.email,
    role: record.role,
    status: record.status,
  }
}
