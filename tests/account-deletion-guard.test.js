import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountDeletionError } from '../src/utils/accountDeletionGuard.js'

// S7: DELETE /api/cashiers/:id (and the Tauri app's own local
// deleteCashier) had no guard against deleting the caller's own account or
// the last remaining admin, which could lock everyone out of the admin
// area entirely.

test('blocks deleting your own account', () => {
  const error = accountDeletionError({ targetId: 'u1', callerId: 'u1' })
  assert.equal(error, 'You cannot delete your own account.')
})

test('blocks deleting the last remaining admin', () => {
  const error = accountDeletionError({ targetId: 'admin1', callerId: 'admin2', targetRole: 'admin', otherAdminCount: 0 })
  assert.equal(error, 'Cannot delete the last remaining admin account.')
})

test('allows deleting an admin when other admins remain', () => {
  const error = accountDeletionError({ targetId: 'admin1', callerId: 'admin2', targetRole: 'admin', otherAdminCount: 1 })
  assert.equal(error, null)
})

test('allows deleting a regular cashier regardless of admin count', () => {
  const error = accountDeletionError({ targetId: 'cashier1', callerId: 'admin1', targetRole: 'cashier', otherAdminCount: 0 })
  assert.equal(error, null)
})

test('self-delete check takes priority even if the target happens to be the last admin', () => {
  const error = accountDeletionError({ targetId: 'admin1', callerId: 'admin1', targetRole: 'admin', otherAdminCount: 0 })
  assert.equal(error, 'You cannot delete your own account.')
})

test('a missing callerId does not crash and does not block the deletion by itself', () => {
  const error = accountDeletionError({ targetId: 'cashier1', callerId: undefined, targetRole: 'cashier', otherAdminCount: 2 })
  assert.equal(error, null)
})
