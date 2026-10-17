// When this terminal should ask the server for a fresh cloud session.
//
// A barcode login's session is an impersonated PocketBase token marked
// `refreshable: false`: authRefresh "succeeds" but returns the same token
// with no extra time, so it used to expire 12 hours after sign-in no matter
// how actively the terminal was used -- and the store is open 24 hours. Such
// a token is renewed through /api/cashier/auth/renew instead, once less than
// RENEW_WHEN_REMAINING_SECONDS of it is left (the session refresh runs every
// 30 minutes, so this leaves many attempts before it actually expires).
// Normal password-login tokens are refreshable and never need this.

export const RENEW_WHEN_REMAINING_SECONDS = 6 * 60 * 60

export function decodeTokenClaims(token) {
  const part = String(token || '').split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const claims = JSON.parse(globalThis.atob(base64))
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    return null
  }
}

export function needsServerRenewal(token, nowMs = Date.now()) {
  const claims = decodeTokenClaims(token)
  if (!claims || claims.refreshable !== false) return false
  const expiresAtMs = Number(claims.exp) * 1000
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false
  return expiresAtMs - nowMs < RENEW_WHEN_REMAINING_SECONDS * 1000
}
