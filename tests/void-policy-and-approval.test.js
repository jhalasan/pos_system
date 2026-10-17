import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALREADY_VOIDED_MESSAGE,
  CLOUD_ONLY_RECEIPT_MESSAGE,
  VOID_NOT_TODAY_MESSAGE,
  voidAvailability,
} from '../src/cashier-pos/utils/voidPolicy.js'
import {
  CASHIER_SESSION_APPROVAL_MESSAGE,
  OFFLINE_PASSWORD_APPROVAL_MESSAGE,
  managerApprovalRoute,
} from '../src/cashier-pos/utils/managerApprovalRoute.js'

// Local-time dates (the terminal runs in Philippine time; these assertions only
// depend on the local calendar, whatever the test machine's zone is).
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min)
const sale = (createdAt, extra = {}) => ({ transactionNo: 'T1', status: 'Completed', rawStatus: 'completed', createdAt: createdAt.toISOString(), ...extra })

// ---- same-day void rule (client request) --------------------------------

test('a sale from today can be voided', () => {
  assert.deepEqual(voidAvailability(sale(at(2026, 10, 18, 9, 0)), { now: at(2026, 10, 18, 15, 0) }), { allowed: true, reason: '' })
})

test("yesterday's sale cannot be voided -- the cashier is pointed to Refund instead", () => {
  const result = voidAvailability(sale(at(2026, 10, 17, 15, 0)), { now: at(2026, 10, 18, 15, 0) })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, VOID_NOT_TODAY_MESSAGE)
})

test('past midnight in the same open shift, an 11:55 PM sale can still be voided at 12:05 AM', () => {
  const shiftOpenedAt = at(2026, 10, 17, 14, 0).toISOString()
  const result = voidAvailability(sale(at(2026, 10, 17, 23, 55)), { now: at(2026, 10, 18, 0, 5), shiftOpenedAt })
  assert.equal(result.allowed, true)
})

test("but a sale from BEFORE the current shift opened, on an earlier day, still cannot", () => {
  const shiftOpenedAt = at(2026, 10, 18, 6, 0).toISOString()
  const result = voidAvailability(sale(at(2026, 10, 17, 22, 0)), { now: at(2026, 10, 18, 9, 0), shiftOpenedAt })
  assert.equal(result.allowed, false)
})

test('an already voided sale, a receipt from another terminal, and an unreadable date are all refused with the right reason', () => {
  const now = at(2026, 10, 18, 15, 0)
  assert.equal(voidAvailability(sale(at(2026, 10, 18), { status: 'Voided', rawStatus: 'voided' }), { now }).reason, ALREADY_VOIDED_MESSAGE)
  assert.equal(voidAvailability(sale(at(2026, 10, 18), { fromCloud: true }), { now }).reason, CLOUD_ONLY_RECEIPT_MESSAGE)
  assert.equal(voidAvailability({ transactionNo: 'T1', createdAt: 'garbage' }, { now }).allowed, false)
  assert.deepEqual(voidAvailability(null), { allowed: false, reason: '' })
})

test('24-hour store: a drawer left open for days does not let a 2-day-old sale be voided', () => {
  const shiftOpenedAt = at(2026, 10, 16, 6, 0).toISOString()
  const result = voidAvailability(sale(at(2026, 10, 16, 8, 0)), { now: at(2026, 10, 18, 9, 0), shiftOpenedAt })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, VOID_NOT_TODAY_MESSAGE)
})

test('24-hour store: an overnight shift can still void its own sales from before midnight', () => {
  const shiftOpenedAt = at(2026, 10, 17, 22, 0).toISOString()
  assert.equal(voidAvailability(sale(at(2026, 10, 17, 22, 30)), { now: at(2026, 10, 18, 5, 45), shiftOpenedAt }).allowed, true)
})

// ---- manager approval route (the "can't confirm" cause) ------------------

test('a signed-in, online cashier verifies the manager online, as before', () => {
  assert.deepEqual(managerApprovalRoute({ offline: false, rateLimited: false, sessionAuthorized: true, usePassword: false }), { route: 'online' })
  assert.deepEqual(managerApprovalRoute({ offline: false, rateLimited: false, sessionAuthorized: true, usePassword: true }), { route: 'online' })
})

test('a cashier with NO cloud login ("Login required" banner) can still get a manager barcode approval, checked offline', () => {
  assert.deepEqual(managerApprovalRoute({ offline: false, rateLimited: false, sessionAuthorized: false, usePassword: false }), { route: 'offline-barcode' })
})

test('...but email/password approval in that state gets a message saying what to do, not "Authentication is required"', () => {
  const result = managerApprovalRoute({ offline: false, rateLimited: false, sessionAuthorized: false, usePassword: true })
  assert.equal(result.route, 'error')
  assert.equal(result.message, CASHIER_SESSION_APPROVAL_MESSAGE)
})

test('offline or rate-limited behaves exactly as before: barcode offline, password refused', () => {
  assert.deepEqual(managerApprovalRoute({ offline: true, rateLimited: false, sessionAuthorized: true, usePassword: false }), { route: 'offline-barcode' })
  assert.deepEqual(managerApprovalRoute({ offline: false, rateLimited: true, sessionAuthorized: true, usePassword: false }), { route: 'offline-barcode' })
  assert.equal(managerApprovalRoute({ offline: true, rateLimited: false, sessionAuthorized: true, usePassword: true }).message, OFFLINE_PASSWORD_APPROVAL_MESSAGE)
})
