import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cashierPayload } from '../server/formatters.js'

// S6: a new cashier/manager account used to fall back to
// DEFAULT_CASHIER_PASSWORD or, failing that, the literal string
// 'cashier123' whenever the caller omitted a password -- a predictable,
// shared default every such account would silently carry. The admin UI
// already requires a real password for a new account; cashierPayload must
// not undermine that by inventing one when the caller (or a direct API
// call bypassing the form) doesn't supply one.

test('cashierPayload never invents a password when none is supplied', () => {
  const payload = cashierPayload({ name: 'New Cashier', email: 'new@example.com' })
  assert.equal(payload.password, '')
  assert.notEqual(payload.password, 'cashier123')
})

test('cashierPayload never falls back to DEFAULT_CASHIER_PASSWORD from the environment either', () => {
  const original = process.env.DEFAULT_CASHIER_PASSWORD
  process.env.DEFAULT_CASHIER_PASSWORD = 'some-shared-default'
  try {
    const payload = cashierPayload({ name: 'New Cashier', email: 'new@example.com' })
    assert.equal(payload.password, '')
  } finally {
    if (original === undefined) delete process.env.DEFAULT_CASHIER_PASSWORD
    else process.env.DEFAULT_CASHIER_PASSWORD = original
  }
})

test('cashierPayload still carries through a real, explicitly supplied password', () => {
  const payload = cashierPayload({ name: 'New Cashier', email: 'new@example.com', password: 'a-real-password-123' })
  assert.equal(payload.password, 'a-real-password-123')
  assert.equal(payload.passwordConfirm, 'a-real-password-123')
})
