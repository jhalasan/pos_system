import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { mintTransactionNumber, peekNextTransactionNumber } from '../src/cashier-pos/offline/transactionNumber.js'

// M4: the old generator was
// `${day}${terminalCharSum % 100}${String(Date.now()).slice(-4)}` -- the
// suffix is the last 4 digits of epoch milliseconds, which wraps every 10
// seconds, so two sales on the same terminal within that window minted the
// identical number. The new generator claims a persistent, atomically
// incremented per-terminal daily counter instead.

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

test('mintTransactionNumber is all-numeric', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  const number = await mintTransactionNumber(new Date('2026-08-15T10:00:00Z'))
  assert.match(number, /^[0-9]+$/, 'BIR/bookkeeping requires an all-numeric transaction number')
  await cashierDb.delete()
})

test('two mints in the same millisecond on the same terminal never collide', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  const now = new Date('2026-08-15T10:00:00.000Z')
  const first = await mintTransactionNumber(now)
  const second = await mintTransactionNumber(now)
  const third = await mintTransactionNumber(now)
  assert.notEqual(first, second)
  assert.notEqual(second, third)
  assert.notEqual(first, third)
  await cashierDb.delete()
})

test('the daily counter resets across day boundaries but stays distinct within a day', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  // Local Date constructors (year, monthIndex, day, ...), not UTC ISO
  // strings -- dateKey uses local calendar-day methods (getFullYear() etc.,
  // matching the old generator's behavior), so a UTC timestamp near
  // midnight can land on a different local calendar day depending on the
  // test runner's timezone.
  const day1 = await mintTransactionNumber(new Date(2026, 7, 15, 23, 59, 59))
  const day2 = await mintTransactionNumber(new Date(2026, 7, 16, 0, 0, 1))
  assert.notEqual(day1, day2)
  assert.equal(day1.slice(0, 8), '20260815')
  assert.equal(day2.slice(0, 8), '20260816')
  // Both are the first sale of their respective day -- same counter suffix,
  // different date prefix, so still no collision.
  assert.equal(day1.slice(-5), '00001')
  assert.equal(day2.slice(-5), '00001')
  await cashierDb.delete()
})

test('peekNextTransactionNumber does not consume the counter', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  const now = new Date('2026-08-15T10:00:00Z')
  const peeked = await peekNextTransactionNumber(now)
  const mintedAfterPeek = await mintTransactionNumber(now)
  assert.equal(peeked, mintedAfterPeek, 'peeking and then minting immediately after must agree -- the peek must not have advanced the counter')
  await cashierDb.delete()
})
