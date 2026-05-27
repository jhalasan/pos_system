import { api } from './services/api'

const KEY = 'nexa_admin_auth'
const USER_KEY = 'nexa_admin_user'

export async function login(email, password) {
  const session = await api.login(email, password)
  sessionStorage.setItem(KEY, '1')
  sessionStorage.setItem(USER_KEY, JSON.stringify(session.user))
  return true
}

export function logout() {
  sessionStorage.removeItem(KEY)
  sessionStorage.removeItem(USER_KEY)
}

export function isAuthed() {
  return sessionStorage.getItem(KEY) === '1'
}

export function currentAdminUser() {
  try {
    return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}
