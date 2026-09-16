// Pure margin/price math shared by the product form (ProductModal.jsx). Kept
// in a plain module (no JSX) so it can be unit-tested directly with
// `node --test`, unlike the component itself.

export function deriveBaseUnitCost(costValue, conversionQuantity) {
  if (!Number.isFinite(costValue) || costValue <= 0) return 0
  const normalizedConversion = Number(conversionQuantity)
  if (!Number.isFinite(normalizedConversion) || normalizedConversion <= 0) return 0
  return costValue / normalizedConversion
}

// Cost is always "the cost of one whole purchase-unit batch" (a case, a
// ream, etc. -- conversionQuantity base units). Whenever conversionQuantity
// itself changes (a Unit Template applied, "Units per Purchase Unit" edited,
// or Multiple Selling Units toggled), the same raw cost number would
// otherwise get silently reinterpreted against a different batch size --
// e.g. a cost entered while the product was single-unit (cost per piece)
// gets divided by 200 the moment a 200-piece Ream template is applied,
// producing a near-zero per-piece cost and, downstream, wildly wrong prices
// and an absurd implied margin. Rescale cost proportionally so the real
// per-base-unit cost the admin already entered is preserved across the
// change instead.
export function rescaleCostForConversionChange(costValue, oldConversionQuantity, newConversionQuantity) {
  const cost = Number(costValue)
  if (!Number.isFinite(cost) || cost <= 0) return costValue
  const oldQty = Number(oldConversionQuantity)
  const newQty = Number(newConversionQuantity)
  if (!Number.isFinite(oldQty) || oldQty <= 0) return costValue
  if (!Number.isFinite(newQty) || newQty <= 0) return costValue
  if (oldQty === newQty) return costValue
  return Number(((cost / oldQty) * newQty).toFixed(2))
}

export function deriveSellingPrice(costValue, profitMargin, conversionValue, conversionQuantity) {
  const baseUnitCost = deriveBaseUnitCost(costValue, conversionQuantity)
  if (!Number.isFinite(baseUnitCost) || baseUnitCost <= 0) return 0
  const normalizedConversion = Number(conversionValue)
  if (!Number.isFinite(normalizedConversion) || normalizedConversion <= 0) return 0
  const normalizedMargin = Number(profitMargin)
  if (!Number.isFinite(normalizedMargin) || normalizedMargin < 0) return 0
  return Number((baseUnitCost * normalizedConversion * (1 + normalizedMargin / 100)).toFixed(2))
}

// The inverse of deriveSellingPrice for the base (conversion=1) unit: when the
// admin types a price directly, back-solve what margin that price implies at
// the current cost, so the Margin field never silently goes stale next to a
// manually-typed price. Returns null when cost/price aren't set yet (nothing
// meaningful to show).
export function deriveImpliedMargin(costValue, conversionQuantity, priceValue) {
  const baseUnitCost = deriveBaseUnitCost(Number(costValue), Number(conversionQuantity))
  if (!Number.isFinite(baseUnitCost) || baseUnitCost <= 0) return null
  const price = Number(priceValue)
  if (!Number.isFinite(price) || price <= 0) return null
  return Number(Math.max(0, ((price / baseUnitCost) - 1) * 100).toFixed(2))
}
