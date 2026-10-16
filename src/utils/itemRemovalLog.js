import { quantizeQty, roundMoney } from './quantity.js'

// Plain digits, no thousands separators, so the parser below can read them back.
const plainQty = (value) => String(quantizeQty(value))

// A cashier can delete a cart line, or lower its quantity, before payment
// without a manager. That is normal retail practice (mis-scans, a customer
// changing their mind), so it is deliberately not gated -- but every removal
// is logged, so it is reviewable on the admin Audit page. The cashier writes
// the log with buildItemRemovalLog and the admin reads it back with
// parseItemRemovalLog; keeping both here stops the text format and its parser
// from drifting apart.
export const ITEM_REMOVED_ACTION = 'Item Removed'

// "by NAME;" must be the first "by" in the text and be followed by ";" --
// that is the shape the Audit page's cashierNameFromDetail already parses.
export function buildItemRemovalLog({ cashierName, name, removedQty, unitPrice, fromQty, toQty, transactionNo }) {
  const removed = Number(removedQty) || 0
  const value = roundMoney(removed * (Number(unitPrice) || 0))
  const how = Number(toQty) > 0
    ? `quantity reduced from ${plainQty(fromQty)} to ${plainQty(toQty)}`
    : 'line removed'
  const clean = (text, fallback) => String(text || fallback).replace(/[;\r\n]+/g, ',').trim() || fallback
  return {
    action: ITEM_REMOVED_ACTION,
    detail: [
      `Item removed by ${clean(cashierName, 'Cashier')}`,
      clean(name, 'Item'),
      `removed qty ${plainQty(removed)}`,
      `value PHP ${value.toFixed(2)}`,
      how,
      `transaction ${clean(transactionNo, 'unknown')}`,
    ].join('; '),
  }
}

export function parseItemRemovalLog(log) {
  if (log?.action !== ITEM_REMOVED_ACTION) return null
  const detail = String(log.detail || '')
  const qty = Number(detail.match(/removed qty\s+([\d.]+)/i)?.[1])
  const value = Number(String(detail.match(/value PHP\s*([\d,]+(?:\.\d+)?)/i)?.[1] || '').replace(/,/g, ''))
  return {
    qty: Number.isFinite(qty) ? qty : 0,
    value: Number.isFinite(value) ? value : 0,
  }
}
