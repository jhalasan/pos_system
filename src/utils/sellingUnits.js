// Shared "selling units" normalizer for the admin pages (ProductManagement, Inventory).
//
// Turns a product's raw `sellingUnits`/`selling_units` array (plus its legacy
// purchaseUnit/conversionQuantity fields) into a consistent list of
// { barcode, unit, conversion, price, wholesalePrice, pricingTier } entries,
// always non-empty.
//
// Note: the cashier POS (Cashier.jsx) has its own richer wrapper on top of
// this that expands a per-unit wholesale price into a separate pickable
// "Wholesale" unit option -- that expansion logic isn't duplicated here since
// it's only meaningful for the cart UI, but wholesalePrice/pricingTier must
// still be passed through per row below, or the cashier's wrapper has nothing
// to expand.
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
    // Preserved so the cashier POS's own richer wrapper (Cashier.jsx's local
    // normalizeSellingUnits) can expand a per-unit wholesale price into a
    // separate pickable "Wholesale" unit option -- dropping these here was a
    // live bug: a product's wholesale price was invisible at the register
    // even though it was correctly saved in Product Management.
    wholesalePrice: Number(unit?.wholesalePrice) || 0,
    pricingTier: String(unit?.pricingTier || '').trim().toLowerCase(),
  }))

  // Some legacy cigarette records stored a ream conversion as the number of
  // packs in a ream (10), while pack conversion is stored in base sticks (20).
  // All current inventory math expects conversions to be in the smallest/base
  // unit, so expand that hierarchical value to 200 sticks.
  const packUnit = units.find((unit) => unit.unit.toLowerCase() === 'pack' && unit.conversion > 1)
  const reamUnit = units.find((unit) => unit.unit.toLowerCase() === 'ream')
  if (packUnit && reamUnit && reamUnit.conversion > 1 && reamUnit.conversion < packUnit.conversion) {
    reamUnit.conversion *= packUnit.conversion
  }

  const purchaseUnit = String(product.purchaseUnit || product.purchase_unit || '').trim()
  const purchaseConversion = Number(product.conversionQuantity ?? product.conversion_quantity)
  if (purchaseUnit && purchaseConversion > 1 && purchaseUnit.toLowerCase() !== fallbackUnit.toLowerCase()) {
    const matchingPurchaseUnit = units.find((unit) => unit.unit.toLowerCase() === purchaseUnit.toLowerCase())
    if (matchingPurchaseUnit && purchaseConversion > matchingPurchaseUnit.conversion) {
      matchingPurchaseUnit.conversion = purchaseConversion
    }
    const hasPurchaseUnit = Boolean(matchingPurchaseUnit || units.some((unit) => Number(unit.conversion) === purchaseConversion))
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
