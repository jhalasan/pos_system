// Shared quantity helpers for fractional (decimal) inventory support.
//
// Every quantity that is stored, compared, or displayed should pass through
// `quantizeQty` (or `floorQty` for availability) before it does. That single
// rule keeps floating-point drift from ever reaching the database — see
// stockMovementReconciler.js, which replays movement history and would
// otherwise churn on values like 0.1 + 0.2 !== 0.3.

export const QTY_DECIMALS = 3
const QTY_SCALE = 10 ** QTY_DECIMALS

/** Round a quantity to the canonical precision (3 decimals). */
export function quantizeQty(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * QTY_SCALE) / QTY_SCALE
}

/** Floor a quantity to the canonical precision. Used for availability so we never over-sell. */
export function floorQty(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.floor(n * QTY_SCALE) / QTY_SCALE
}

/** Convert a quantity to an exact integer count of thousandths, for drift-free summation. */
export function toMillis(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * QTY_SCALE)
}

/** Convert an integer count of thousandths back to a quantity. */
export function fromMillis(millis) {
  const n = Number(millis)
  if (!Number.isFinite(n)) return 0
  return n / QTY_SCALE
}

/** Round a money value to centavos (2 decimals). */
export function roundMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/** Format a quantity for display, trimming trailing zeros (2, 0.5, 1.75 — never "2.000"). */
export function formatQty(value) {
  const n = quantizeQty(value)
  return n.toLocaleString('en-PH', { maximumFractionDigits: QTY_DECIMALS })
}

/** Pluralize a unit label; singular only at exactly 1 (1 kg, 0.5 Pieces, 2 Cases). */
export function pluralizeUnit(unit, quantity, irregulars = {}) {
  const label = String(unit || '').trim()
  if (!label) return label
  if (Number(quantity) === 1) return label
  const lower = label.toLowerCase()
  if (irregulars[lower]) return irregulars[lower]
  // A label already ending in "s" is assumed already plural (e.g. a unit
  // literally named "Bottles") rather than re-pluralized into "Bottleses".
  if (/s$/i.test(label)) return label
  return `${label}s`
}

/** Whether a product accepts fractional (decimal) quantities. */
export function isFractional(product) {
  return Boolean(product?.allowFractional ?? product?.allow_fractional)
}
