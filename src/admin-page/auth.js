/* Minimal client-side auth stub for the admin dashboard demo.
   No real security — wire to a backend before production use. */

const KEY = 'nexa_admin_auth'

/* Demo credential. Replace with a real auth call. */
const DEMO_PASSWORD = 'admin123'

export function login(password) {
  if (password === DEMO_PASSWORD) {
    sessionStorage.setItem(KEY, '1')
    return true
  }
  return false
}

export function logout() {
  sessionStorage.removeItem(KEY)
}

export function isAuthed() {
  return sessionStorage.getItem(KEY) === '1'
}
