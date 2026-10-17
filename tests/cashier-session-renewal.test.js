import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeTokenClaims, needsServerRenewal, RENEW_WHEN_REMAINING_SECONDS } from '../src/cashier-pos/utils/sessionRenewal.js'

// Builds a PocketBase-shaped JWT (only the payload matters to the client;
// the signature is checked by PocketBase, never here).
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`
const NOW = Date.UTC(2026, 9, 18, 4, 0, 0)
const inSeconds = (s) => Math.floor(NOW / 1000) + s

test('a barcode login token (refreshable: false) is NOT renewed while plenty of it is left', () => {
  assert.equal(needsServerRenewal(jwt({ type: 'auth', refreshable: false, exp: inSeconds(11 * 3600) }), NOW), false)
})

test('a barcode login token IS renewed once less than 6 hours remain', () => {
  assert.equal(needsServerRenewal(jwt({ type: 'auth', refreshable: false, exp: inSeconds(RENEW_WHEN_REMAINING_SECONDS - 60) }), NOW), true)
  assert.equal(needsServerRenewal(jwt({ type: 'auth', refreshable: false, exp: inSeconds(5 * 60) }), NOW), true)
})

test('an already-expired token is never sent for renewal (the server would refuse it; the cashier must sign in)', () => {
  assert.equal(needsServerRenewal(jwt({ type: 'auth', refreshable: false, exp: inSeconds(-1) }), NOW), false)
})

test('a normal password-login token (refreshable) never uses the renew endpoint', () => {
  assert.equal(needsServerRenewal(jwt({ type: 'auth', refreshable: true, exp: inSeconds(60) }), NOW), false)
  assert.equal(needsServerRenewal(jwt({ type: 'auth', exp: inSeconds(60) }), NOW), false)
})

test('missing or malformed tokens are ignored, never thrown on', () => {
  for (const token of ['', null, undefined, 'abc', 'a.b.c', 'a.!!!.c']) {
    assert.equal(needsServerRenewal(token, NOW), false)
  }
  assert.equal(decodeTokenClaims('a.!!!.c'), null)
})

test('base64url payloads with - and _ decode correctly', () => {
  const claims = { id: '~~~???>>>', refreshable: false, exp: inSeconds(60) }
  assert.deepEqual(decodeTokenClaims(jwt(claims)), claims)
})
