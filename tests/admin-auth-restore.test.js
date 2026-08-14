import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreAdminAuthStore } from '../src/admin-page/offline/runtime.js'

function fakeAuthStore() {
  let token = ''
  let record = null
  return {
    get isValid() { return Boolean(token && record) },
    get record() { return record },
    save(nextToken, nextRecord) { token = nextToken; record = nextRecord },
    clear() { token = ''; record = null },
  }
}

test('an already-valid admin auth store is left as-is', async () => {
  const authStore = fakeAuthStore()
  authStore.save('tok', { id: 'u1', role: 'admin' })

  const restored = await restoreAdminAuthStore(authStore, {})
  assert.equal(restored, true)
  assert.equal(authStore.record.id, 'u1')
})

test('a sessionStorage token/user pair rehydrates an empty admin auth store', async () => {
  const authStore = fakeAuthStore()

  const restored = await restoreAdminAuthStore(authStore, {
    token: 'session-token',
    user: { id: 'u2', role: 'admin' },
  })

  assert.equal(restored, true)
  assert.equal(authStore.isValid, true)
  assert.equal(authStore.record.id, 'u2')
})

test('a non-admin session user is rejected and the store is cleared', async () => {
  const authStore = fakeAuthStore()
  authStore.save('stale-token', { id: 'u3', role: 'cashier' })

  const restored = await restoreAdminAuthStore(authStore, {
    token: 'session-token',
    user: { id: 'u3', role: 'cashier' },
  })

  assert.equal(restored, false)
  assert.equal(authStore.isValid, false)
})

test('no session data at all clears the store and reports unrestored', async () => {
  const authStore = fakeAuthStore()
  authStore.save('stale-token', { id: 'u4', role: 'admin' })
  authStore.clear() // simulate an expired token already cleared by the SDK

  const restored = await restoreAdminAuthStore(authStore, {})
  assert.equal(restored, false)
  assert.equal(authStore.isValid, false)
})
