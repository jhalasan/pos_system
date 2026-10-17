// When a completed sale may be voided from this terminal.
//
// Client rule: only same-day transactions can be voided; anything older goes
// through Refund Items instead. The store also trades past midnight (sales at
// 12:21 and 12:30 AM appear in its history), so a sale made during the
// cashier's CURRENT open shift still counts as "today" even if the calendar
// date has turned over -- otherwise an 11:55 PM sale could not be voided at
// 12:05 AM in the same shift. The store is open 24 hours, so a drawer left
// open (no End of Day) would otherwise stretch "current shift" back days;
// that allowance is capped at MAX_SHIFT_VOID_AGE_HOURS.

export const MAX_SHIFT_VOID_AGE_HOURS = 24
export const CLOUD_ONLY_RECEIPT_MESSAGE = 'This receipt was made on another terminal (or is not stored on this one). You can verify and reprint it here, but a void, refund or exchange must be done on the terminal that made the sale.'
export const VOID_NOT_TODAY_MESSAGE = "Only today's transactions can be voided. For an older receipt, use Refund Items instead."
export const ALREADY_VOIDED_MESSAGE = 'This transaction is already voided.'

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function voidAvailability(sale, { now = new Date(), shiftOpenedAt = null } = {}) {
  if (!sale) return { allowed: false, reason: '' }
  if (sale.rawStatus === 'voided' || sale.status === 'Voided' || sale.status === 'voided') {
    return { allowed: false, reason: ALREADY_VOIDED_MESSAGE }
  }
  if (sale.fromCloud) return { allowed: false, reason: CLOUD_ONLY_RECEIPT_MESSAGE }

  const created = new Date(sale.createdAt)
  if (Number.isNaN(created.getTime())) return { allowed: false, reason: VOID_NOT_TODAY_MESSAGE }
  const current = now instanceof Date ? now : new Date(now)
  if (sameLocalDay(created, current)) return { allowed: true, reason: '' }

  const shiftStart = shiftOpenedAt ? new Date(shiftOpenedAt) : null
  const withinShiftCap = current.getTime() - created.getTime() <= MAX_SHIFT_VOID_AGE_HOURS * 3_600_000
  if (shiftStart && !Number.isNaN(shiftStart.getTime()) && created >= shiftStart && withinShiftCap) {
    return { allowed: true, reason: '' }
  }
  return { allowed: false, reason: VOID_NOT_TODAY_MESSAGE }
}
