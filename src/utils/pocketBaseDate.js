// PocketBase stores date/autodate fields as text shaped "2026-10-15 23:59:47.615Z"
// -- a SPACE between date and time, not the "T" of an ISO string -- and filter
// comparisons on them are plain text comparisons. A bound written as
// "2026-10-15T17:32:30.316Z" therefore sorts AFTER every stored value on the
// same calendar date (a space sorts before "T"), so:
//   `field >= "<date>T<time>Z"` silently drops every row on the bound's own
//     UTC date, even ones later than the bound;
//   `field <= "<date>T<time>Z"` wrongly keeps every row on the bound's own
//     UTC date, even ones later than the bound.
// For this Philippine store (UTC+8) that shifted every daily report by eight
// hours: a PH day's sales between midnight and 08:00 were dropped and the next
// day's were pulled in. Measured live on 2026-10-15: the correct set was 315
// sales / PHP 61,994, the ISO-bound query returned 354 / PHP 64,494 (27 real
// sales missing, 66 of the next day's included).
//
// Bounds sent to a PocketBase filter must use PocketBase's own format.
export function toPocketBaseDate(value) {
  if (value === undefined || value === null || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  // An unparseable value is passed through untouched rather than guessed at.
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ')
}
