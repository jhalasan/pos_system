import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { phDateStringToUtcMillis } = await import('../server/index.js')

// Root cause of a live client report: a shop owner hand-tallied a cashier's
// 2nd-shift transactions and got a much larger total than the admin's "Sales
// by Cashier" report showed for the same day. server/index.js's /api/receipts
// and /api/dashboard routes parsed `fromDate`/`toDate` with
// `new Date(`${dateStr}T00:00:00`)` -- no timezone suffix, so it resolves to
// midnight in whatever timezone the Node process itself runs in. This app is
// deployed to Vercel (server/index.js is proxied to a serverless function per
// vercel.json), which runs in UTC by default, while the shop is in the
// Philippines (UTC+8). "August 25" was therefore actually being read as
// 8:00 AM Aug 25 PH through 7:59:59 AM Aug 26 PH -- silently moving that
// cashier's entire early-morning shift into the *previous* day's report.
// phDateStringToUtcMillis anchors the parse to a fixed +08:00 offset so the
// boundary is correct regardless of the host's local timezone.

test('phDateStringToUtcMillis: start-of-day resolves to PH midnight regardless of host TZ', () => {
  const millis = phDateStringToUtcMillis('2026-08-25', false)
  // PH midnight Aug 25 == UTC 16:00 Aug 24.
  assert.equal(new Date(millis).toISOString(), '2026-08-24T16:00:00.000Z')
})

test('phDateStringToUtcMillis: end-of-day resolves to the last instant of PH Aug 25', () => {
  const millis = phDateStringToUtcMillis('2026-08-25', true)
  // PH 23:59:59.999 Aug 25 == UTC 15:59:59.999 Aug 26.
  assert.equal(new Date(millis).toISOString(), '2026-08-25T15:59:59.999Z')
})

test('phDateStringToUtcMillis: a transaction at 6:18 AM PH on Aug 25 falls inside the Aug 25 PH range', () => {
  const from = phDateStringToUtcMillis('2026-08-25', false)
  const to = phDateStringToUtcMillis('2026-08-25', true)
  const saleAt618AmPh = new Date('2026-08-24T22:18:00.000Z').getTime() // 6:18 AM PH Aug 25
  assert.ok(saleAt618AmPh >= from && saleAt618AmPh <= to)
})

test('phDateStringToUtcMillis: returns null for an empty/missing date string', () => {
  assert.equal(phDateStringToUtcMillis('', false), null)
  assert.equal(phDateStringToUtcMillis(undefined, true), null)
})
