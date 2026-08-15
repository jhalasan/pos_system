import { cashierDb } from './db.js'
import { getTerminalId } from '../../utils/terminalIdentity.js'

// Replaces the old `${day}${terminalCharSum % 100}${String(Date.now()).slice(-4)}`
// (desktopApi.js's localTransactionNumber): that suffix was the last 4
// digits of epoch milliseconds, which wraps every 10 seconds -- two sales on
// the same terminal within that window minted the identical number, and the
// 2-digit terminal code (a char-sum mod 100) let two different terminal IDs
// collide too.
//
// Format is all-numeric (BIR/bookkeeping requirement -- do not change
// without the client): YYYYMMDD (8 digits) + terminal ordinal (6 digits) +
// per-terminal daily counter (5 digits) = 19 digits.
//
// The terminal ordinal is a deterministic hash of the terminal ID, not a
// centrally-assigned one -- there is no server this offline-first terminal
// can register with before ringing its first sale. Two different terminal
// IDs hashing to the same 6-digit ordinal would only actually collide if
// they also minted the same daily counter value that same day, which is
// acceptable at the scale this system is tuned for (the rate limiter is
// tuned for 1-2 terminals; see POS_AUDIT_REGISTER.md).
function terminalOrdinal(terminalId) {
  let hash = 0
  for (const char of String(terminalId)) {
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  }
  return hash % 1_000_000
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('')
}

function counterSettingsKey(date, terminalId) {
  return `txnCounter:${dateKey(date)}:${terminalId}`
}

// Atomically claims the next counter value and returns the finished number.
// MUST be called from inside a Dexie transaction that includes
// `cashierDb.settings` in its table list (finalizeSaleLocally does this) --
// that is what makes the claim atomic against two sales finalizing at
// "the same time" on one terminal. Calling this outside a transaction still
// works but loses that guarantee.
export async function mintTransactionNumber(now = new Date()) {
  const terminalId = getTerminalId()
  const key = counterSettingsKey(now, terminalId)
  const existing = await cashierDb.settings.get(key)
  const nextCount = (Number(existing?.value) || 0) + 1
  await cashierDb.settings.put({ key, value: nextCount })

  const day = dateKey(now)
  const ordinal = String(terminalOrdinal(terminalId)).padStart(6, '0')
  const counter = String(nextCount).padStart(5, '0')
  return `${day}${ordinal}${counter}`
}

// Read-only estimate for UI display before a sale is actually finalized
// (e.g. showing "next transaction number" while a cart is still being
// built). Does NOT claim the counter -- the number actually recorded at
// checkout is minted fresh by mintTransactionNumber inside
// finalizeSaleLocally, and may differ from this preview if another
// transaction on this terminal finalizes first (multiple open tabs). That
// is intentional: the preview is a display hint, not a reservation.
export async function peekNextTransactionNumber(now = new Date()) {
  const terminalId = getTerminalId()
  const key = counterSettingsKey(now, terminalId)
  const existing = await cashierDb.settings.get(key)
  const nextCount = (Number(existing?.value) || 0) + 1

  const day = dateKey(now)
  const ordinal = String(terminalOrdinal(terminalId)).padStart(6, '0')
  const counter = String(nextCount).padStart(5, '0')
  return `${day}${ordinal}${counter}`
}
