// Shared inventory unit-breakdown math for the admin Product Management page
// (used for both the on-screen expandable breakdown and the products CSV
// export). Extracted out of ProductManagement.jsx so it is testable -- the
// lack of test coverage here is exactly how a "0.155 Sack" / "0.008 Pieces"
// bug shipped, see tests/inventory-breakdown.test.js and
// POS_AUDIT_REGISTER.md for the investigation.
//
// A container count (how many Sacks, Cases, half-kilos, etc. are in stock)
// is never meaningful as a decimal -- "0.155 sacks" doesn't mean anything to
// a cashier. All arithmetic here floors to whole units, regardless of
// whether the product is flagged fractional; the fractional flag only
// controls whether the *base-unit* quantity itself (e.g. kilos) can be a
// decimal, not whether a container count can be.
//
// All division happens in integer thousandths via toMillis, matching this
// repo's existing drift-free-quantity convention (see quantity.js's header
// comment), so a run of many small fractional conversions can't accumulate
// float error into a wrong whole-number count.
import { normalizeSellingUnits } from './sellingUnits.js'
import { toMillis, pluralizeUnit } from './quantity.js'

function sellingUnitsByConversionDesc(product) {
  return normalizeSellingUnits(product)
    .map((unit) => ({ ...unit, conversionMillis: toMillis(Number(unit.conversion) || 0) }))
    .filter((unit) => unit.conversionMillis > 0)
    .sort((a, b) => b.conversionMillis - a.conversionMillis)
}

// Independent per-unit capacity: "how many whole X could this stock make if
// it were entirely repackaged into X" -- e.g. the CSV export's "83 case
// available". Each unit is computed on its own, not a remainder chain, so
// these numbers do not sum to the total stock (that's getInventoryRemainderBreakdown).
export function getInventoryBreakdown(product) {
  const qtyMillis = toMillis(Number(product.qty) || 0)
  return sellingUnitsByConversionDesc(product).map((unit) => {
    const { conversionMillis, ...rest } = unit
    return {
      ...rest,
      total: Math.floor(qtyMillis / conversionMillis),
    }
  })
}

// Greedy largest-container-first breakdown of the actual stock into whole
// units -- "7 Kilogram, 1 half-kilo, 1 quarter-kilo" for 7.75kg. Every row,
// including the smallest/last one, floors to a whole count; when stock
// doesn't divide evenly the leftover (always smaller than the smallest
// configured unit) is simply dropped rather than shown as a decimal. This is
// a deliberate trade-off: the breakdown can under-report stock by a sliver
// (e.g. 7.8kg -> "7 / 1 / 1" = 7.75kg accounted for, 0.05kg unaccounted),
// but it never shows "1.2 quarter-kilos". The exact total is always still
// available in the Stock column, which this function does not touch.
export function getInventoryRemainderBreakdown(product) {
  let remainingMillis = toMillis(Number(product.qty) || 0)
  return sellingUnitsByConversionDesc(product).map((unit) => {
    const { conversionMillis, ...rest } = unit
    const count = Math.floor(remainingMillis / conversionMillis)
    remainingMillis -= count * conversionMillis
    return {
      ...rest,
      count,
    }
  })
}

// (F) marks a bulk/"full container" unit (a Sack, a Case) using its own
// configured name; (L) marks a "loose" unit at or below the base unit,
// pluralized. Both branches use the selling unit's own name (falling back to
// the product's base unit only if the selling unit has none) so that, e.g.,
// a 1/2 KILO row reads "1/2 KILO" rather than the product's base unit name
// "Kilograms".
export function breakdownUnitLabel(product, unit) {
  const ownLabel = String(unit?.unit || '').trim()
  const label = ownLabel || String(product?.unit || 'unit').trim() || 'unit'
  if (Number(unit?.conversion) > 1) return `${label} (F)`
  return `${pluralizeUnit(label, unit?.count)} (L)`
}
