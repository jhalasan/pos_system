// Pure date-boundary helpers for the cashier "Recent Transactions" history
// list. Desktop-only: this runs on the shop's own PH-timezone PC, so plain
// local Date math is correct here (unlike the Vercel-hosted admin backend,
// which runs in UTC and needed its own PH-anchored helpers -- see
// server/index.js's phDateParts/phMidnight and tests/ph-date-range.test.js).
//
// Written to fix a client-reported bug: the history list claimed to show
// "today" but had no date bound at all, silently mixing in every prior day's
// transactions and getting slower to load every day the shop operates.
export function startOfLocalDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfLocalDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

export function toDateInputValue(date) {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Parses a 'YYYY-MM-DD' <input type="date"> value as LOCAL midnight. Never
// pass the bare string to `new Date(...)` directly -- that parses it as UTC
// midnight, which can land on the wrong local calendar day.
export function dateInputValueToDate(value) {
  return new Date(`${value}T00:00:00`)
}

export function addDays(date, delta) {
  const d = new Date(date)
  d.setDate(d.getDate() + delta)
  return d
}

export function isToday(date) {
  return toDateInputValue(date) === toDateInputValue(new Date())
}
