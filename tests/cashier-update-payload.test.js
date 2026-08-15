import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cashierUpdatePayload } from '../src/admin-page/utils/cashierUpdatePayload.js'

// S5, desktop parity: the web admin's PATCH /api/cashiers/:id was fixed to
// never default an omitted field (see tests/cashier-patch-payload.test.js).
// But the desktop (Tauri) admin app -- the client's primary app -- writes
// staff edits straight to PocketBase via a completely separate code path
// that still reused the create-time payload builder for updates too. A
// name-only edit there would have silently reactivated a terminated account
// (status defaulted to 'active') and reset permissions to [] (which the
// rules script treats as full legacy access, not no access). This mirrors
// the same fix for that path.

test('an edit that only sends a name does not touch status, permissions, or barcode', () => {
  const payload = cashierUpdatePayload({ name: 'Renamed Cashier' })
  assert.deepEqual(payload, { name: 'Renamed Cashier' })
  assert.equal('status' in payload, false)
  assert.equal('permissions' in payload, false)
  assert.equal('void_barcode' in payload, false)
})

test('an explicit status is passed through unchanged', () => {
  const payload = cashierUpdatePayload({ status: 'inactive' })
  assert.equal(payload.status, 'inactive')
})

test('an explicit empty permissions array is passed through (caller intent, not a default)', () => {
  const payload = cashierUpdatePayload({ permissions: [] })
  assert.deepEqual(payload.permissions, [])
})

test('a non-array permissions value normalizes to an empty array, not undefined', () => {
  const payload = cashierUpdatePayload({ permissions: 'not-an-array' })
  assert.deepEqual(payload.permissions, [])
})

test('omitting password never includes password fields', () => {
  const payload = cashierUpdatePayload({ name: 'X' })
  assert.equal('password' in payload, false)
  assert.equal('passwordConfirm' in payload, false)
  assert.equal('oldPassword' in payload, false)
})

test('an explicit password is included with a matching confirm', () => {
  const payload = cashierUpdatePayload({ password: 'a-new-password' })
  assert.equal(payload.password, 'a-new-password')
  assert.equal(payload.passwordConfirm, 'a-new-password')
})

test('a manager barcode without the 92 prefix gets it added, same as create', () => {
  const payload = cashierUpdatePayload({ role: 'manager', cashierBarcode: '12345' })
  assert.equal(payload.void_barcode, '9212345')
})

test('a cashier barcode is left as-is, no 92 prefix added', () => {
  const payload = cashierUpdatePayload({ role: 'cashier', cashierBarcode: '12345' })
  assert.equal(payload.void_barcode, '12345')
})

test('role itself is never included in the payload', () => {
  const payload = cashierUpdatePayload({ role: 'manager', name: 'X' })
  assert.equal('role' in payload, false)
})
