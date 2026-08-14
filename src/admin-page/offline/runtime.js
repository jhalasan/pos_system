import { LocalAuthStore } from 'pocketbase'

// Mirrors src/cashier-pos/offline/runtime.js's restoreCashierAuthStore. The
// admin side never had an equivalent: after any reload with an expired or
// absent pb.authStore token, every admin data call threw "Admin login is
// required." with no way back to a working session short of a manual
// logout/login — this restores from whatever is available, in order of
// preference, the same way the cashier side already does.
export function restoreAdminAuthStore(authStore, { token, user } = {}) {
  if (authStore.isValid && authStore.record?.role === 'admin') return true
  authStore.clear()

  // Migrate a valid admin session saved by app versions that used
  // PocketBase's default shared auth key.
  const legacyStore = new LocalAuthStore()
  if (legacyStore.isValid && legacyStore.record?.role === 'admin') {
    authStore.save(legacyStore.token, legacyStore.record)
    return true
  }

  // sessionStorage survives a same-tab reload even though the in-memory
  // adminSession/pb.authStore do not (see src/admin-page/auth.js). If it
  // still holds a valid admin token, rehydrating here is what actually
  // closes the gap between the three previously-unsynchronized session
  // stores.
  if (token && user?.role === 'admin') {
    authStore.save(token, user)
    if (authStore.isValid) return true
  }

  authStore.clear()
  return false
}

// Wraps a runtime bootstrap so a rejected attempt does not get cached
// forever. `runtimePromise ||= bootstrap()` (the previous shape) is truthy
// even when it rejects, so every later call kept rejecting identically for
// the life of the process — a single Dexie VersionError/blocked-upgrade/quota
// error permanently broke the admin app on that terminal.
export function createRetryableRuntime(bootstrap) {
  let runtimePromise = null

  function start() {
    if (runtimePromise) return runtimePromise
    const attempt = Promise.resolve().then(bootstrap)
    runtimePromise = attempt
    attempt.catch(() => {
      if (runtimePromise === attempt) runtimePromise = null
    })
    return attempt
  }

  /** Test-only: clears the cached attempt so suites don't leak state into each other. */
  function reset() {
    runtimePromise = null
  }

  return { start, reset }
}
