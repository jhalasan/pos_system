import { api } from './services/api'

const KEY = 'nexa_admin_auth'
const USER_KEY = 'nexa_admin_user'
const TOKEN_KEY = 'nexa_admin_token'
const isAdminWeb = import.meta.env.VITE_APP_TARGET === 'admin-web'

export async function login(email, password) {
  const session = await api.login(email, password)
  sessionStorage.setItem(KEY, '1')
  sessionStorage.setItem(USER_KEY, JSON.stringify(session.user))
  if (session.token) sessionStorage.setItem(TOKEN_KEY, session.token)
  localStorage.removeItem(KEY)
  localStorage.removeItem(USER_KEY)
  return true
}

export function logout() {
  sessionStorage.removeItem(KEY)
  sessionStorage.removeItem(USER_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(KEY)
  localStorage.removeItem(USER_KEY)
  api.logout?.()
}

export function isAuthed() {
  return sessionStorage.getItem(KEY) === '1'
    && (!isAdminWeb || Boolean(sessionStorage.getItem(TOKEN_KEY)))
}

export function currentAdminUser() {
  try {
    return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}
