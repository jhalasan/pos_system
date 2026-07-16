function sellingUnits(data = {}) {
  if (Array.isArray(data.sellingUnits)) return data.sellingUnits
  if (Array.isArray(data.selling_units)) return data.selling_units
  return []
}

export function resolveRequiredProductPrice(data = {}) {
  const explicitPrice = Number(data.price)
  if (Number.isFinite(explicitPrice) && explicitPrice > 0) return explicitPrice

  const units = sellingUnits(data)
  const baseUnitPrice = Number(units.find((unit) => Number(unit?.conversion) === 1)?.price)
  if (Number.isFinite(baseUnitPrice) && baseUnitPrice > 0) return baseUnitPrice

  const pricedUnit = units.find((unit) => Number(unit?.price) > 0 && Number(unit?.conversion) > 0)
  if (pricedUnit) return Number((Number(pricedUnit.price) / Number(pricedUnit.conversion)).toFixed(2))

  const cost = Number(data.cost)
  const conversion = Number(data.conversionQuantity ?? data.conversion_quantity ?? 1)
  const margin = Number(data.profitMargin)
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(conversion) && conversion > 0) {
    const markup = Number.isFinite(margin) && margin >= 0 ? 1 + (margin / 100) : 1
    return Number(((cost / conversion) * markup).toFixed(2))
  }

  // PocketBase treats zero as blank for this required number field.
  return 0.01
}
