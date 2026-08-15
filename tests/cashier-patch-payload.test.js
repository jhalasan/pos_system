import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cashierPatchPayload } from '../server/formatters.js'

// Regression coverage for S5: PATCH /api/cashiers/:id used to run every
// edit through cashierPayload (built for POST, where every field needs a
// default because the record is brand new). That meant a PATCH which only
// renamed a cashier also silently re-activated a deactivated account
// (status defaulted to 'active'), reset permissions to [] (which the rules
// script treats as "full legacy access", not "no access"), and would have
// overwritten role to 'cashier' had this endpoint ever been pointed at a
// non-cashier id.

test('an edit that only sends a name does not touch status, permissions, or role', () => {
  const payload = cashierPatchPayload({ name: 'Renamed Cashier' })
  assert.deepEqual(payload, { name: 'Renamed Cashier' })
  assert.equal('status' in payload, false)
  assert.equal('permissions' in payload, false)
  assert.equal('role' in payload, false)
})

test('an explicit status is passed through unchanged', () => {
  const payload = cashierPatchPayload({ status: 'inactive' })
  assert.equal(payload.status, 'inactive')
})

test('an explicit empty permissions array is passed through (caller intent, not a default)', () => {
  const payload = cashierPatchPayload({ permissions: [] })
  assert.deepEqual(payload.permissions, [])
})

test('omitting password never includes password fields', () => {
  const payload = cashierPatchPayload({ name: 'X' })
  assert.equal('password' in payload, false)
  assert.equal('passwordConfirm' in payload, false)
})

test('an explicit password is included', () => {
  const payload = cashierPatchPayload({ password: 'a-new-password' })
  assert.equal(payload.password, 'a-new-password')
  assert.equal(payload.passwordConfirm, 'a-new-password')
})

test('a manager barcode without the 92 prefix gets it added, same as create', () => {
  const payload = cashierPatchPayload({ role: 'manager', cashierBarcode: '12345' })
  assert.equal(payload.void_barcode, '9212345')
})

test('barcode is left untouched when not part of the edit', () => {
  const payload = cashierPatchPayload({ name: 'X' })
  assert.equal('void_barcode' in payload, false)
})
