// Shared "selling units" normalizer for the admin pages (ProductManagement, Inventory).
//
// Turns a product's raw `sellingUnits`/`selling_units` array (plus its legacy
// purchaseUnit/conversionQuantity fields) into a consistent list of
// { barcode, unit, conversion, price } entries, always non-empty.
//
// Note: the cashier POS (Cashier.jsx) has its own richer version that also
// expands retail/wholesale pricing tiers into separate pickable units — that
// one is intentionally not merged here, since its shape differs (adds
// `pricingTier`) and is consumed only by the cart UI.
export function normalizeSellingUnits(product = {}) {
  const rawUnits = Array.isArray(product.sellingUnits)
    ? product.sellingUnits
    : (Array.isArray(product.selling_units) ? product.selling_units : [])
  const fallbackUnit = String(product.unit || 'Piece').trim() || 'Piece'
  const fallbackBarcode = String(product.barcode || '').trim()
  const fallbackPrice = Number(product.price) || 0

  const units = rawUnits.map((unit) => ({
    barcode: String(unit?.barcode || '').trim(),
    unit: String(unit?.unit || '').trim() || fallbackUnit,
    conversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
    price: Number(unit?.price) || fallbackPrice,
  }))

  const purchaseUnit = String(product.purchaseUnit || product.purchase_unit || '').trim()
  const purchaseConversion = Number(product.conversionQuantity ?? product.conversion_quantity)
  if (purchaseUnit && purchaseConversion > 1 && purchaseUnit.toLowerCase() !== fallbackUnit.toLowerCase()) {
    const hasPurchaseUnit = units.some((unit) => (
      unit.unit.toLowerCase() === purchaseUnit.toLowerCase()
      || Number(unit.conversion) === purchaseConversion
    ))
    if (!hasPurchaseUnit) {
      units.push({
        barcode: '',
        unit: purchaseUnit,
        conversion: purchaseConversion,
        price: fallbackPrice * purchaseConversion,
      })
    }
  }

  if (units.length > 0) return units

  return [{
    barcode: fallbackBarcode,
    unit: fallbackUnit,
    conversion: 1,
    price: fallbackPrice,
  }]
}
