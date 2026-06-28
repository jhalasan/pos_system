import PocketBase from 'pocketbase'
import 'dotenv/config'

const POCKETBASE_ENDPOINTS = {
  // 1. PRODUCTION / DEPLOYMENT:
  // Use this when the live API domain is ready.
  production: 'https://api.yourstartup.com',

  // 2. REMOTE TEAM TESTING:
  // WARNING: ngrok URLs change every time ngrok restarts unless you use a reserved domain.
  remoteTeamTesting: 'https://xxxx.ngrok-free.app',

  // 3. LOCAL ALONE DEVELOPMENT:
  // Use this when PocketBase is running on this machine.
  localAloneDevelopment: 'http://127.0.0.1:8090',
}

const POCKETBASE_PHASE =
  process.env.POCKETBASE_PHASE ||
  (process.env.NODE_ENV === 'production' ? 'production' : 'localAloneDevelopment')

// Manual phase switch examples:
// const POCKETBASE_PHASE = 'production'
// const POCKETBASE_PHASE = 'remoteTeamTesting'
// const POCKETBASE_PHASE = 'localAloneDevelopment'

export const PB_URL = process.env.POCKETBASE_URL || POCKETBASE_ENDPOINTS[POCKETBASE_PHASE] || POCKETBASE_ENDPOINTS.localAloneDevelopment
const PB_SUPERUSER_EMAIL = process.env.POCKETBASE_SUPERUSER_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL
const PB_SUPERUSER_PASSWORD = process.env.POCKETBASE_SUPERUSER_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD

export const pb = new PocketBase(PB_URL)
pb.autoCancellation(false)

export default pb

let authPromise = null

async function authAsPocketBaseAdmin() {
  try {
    await pb.collection('_superusers').authWithPassword(
      PB_SUPERUSER_EMAIL,
      PB_SUPERUSER_PASSWORD,
    )
  } catch (error) {
    if (error.status !== 404) throw error
    try {
      await pb.collection('_admins').authWithPassword(
        PB_SUPERUSER_EMAIL,
        PB_SUPERUSER_PASSWORD,
      )
    } catch (legacyError) {
      if (legacyError.status === 404) {
        const configError = new Error('PocketBase auth endpoint was not found. Set POCKETBASE_URL to your PocketBase server, usually http://127.0.0.1:8090. Do not set POCKETBASE_URL to the Express/ngrok API URL.')
        configError.status = 500
        throw configError
      }
      throw legacyError
    }
  }
}

export async function ensurePocketBaseAuth() {
  if (!PB_SUPERUSER_EMAIL || !PB_SUPERUSER_PASSWORD) {
    const error = new Error('PocketBase superuser credentials are missing. Set POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in .env.')
    error.status = 500
    throw error
  }
  if (pb.authStore.isValid) return

  authPromise ||= authAsPocketBaseAdmin()

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
  const authData = await authClient.collection('users').authWithPassword(email, password).catch((error) => {
    const message = error?.response?.message || error?.data?.message || error?.message || ''
    const authError = new Error(
      /something went wrong|failed to authenticate|invalid login|invalid.*password|unauthorized/i.test(message)
        ? 'Invalid email or password.'
        : (message || 'Unable to login right now.')
    )
    authError.status = error?.status || 401
    throw authError
  })
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
