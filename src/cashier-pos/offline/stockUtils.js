import { quantizeQty, floorQty, isFractional } from '../../utils/quantity.js'

export function toBaseStockQuantity(quantity, conversion = 1) {
  const normalizedQuantity = Number(quantity) || 0
  const normalizedConversion = Number(conversion) > 0 ? Number(conversion) : 1
  return quantizeQty(normalizedQuantity * normalizedConversion)
}

export function getStockQuantity(product = {}) {
  const quantity = Number(product?.quantity ?? product?.qty ?? 0) || 0
  return Math.max(0, quantity)
}

// Fractional products report the exact remainder (2.5 kg in stock offers 2.5
// available); discrete products keep flooring to whole selling units so a
// cashier can never sell a partial can.
export function getAvailableStockUnits(product = {}, unit = {}) {
  const stockQty = getStockQuantity(product)
  const conversion = Number(unit?.conversion ?? unit?.conversionQuantity ?? product?.conversion ?? 1) || 1
  if (conversion <= 0) return 0
  const available = stockQty / conversion
  return isFractional(product) ? Math.max(0, floorQty(available)) : Math.max(0, Math.floor(available))
}

// Which unit to offer when a cashier clicks an item (no barcode scanned). The
// item's first unit is the default, but a product sold by the ream (or case)
// with less than one of them left still has plenty of pieces: refusing with
// "out of stock" there blocked sales of the loose pieces unless the piece
// barcode was scanned. Keep the default whenever it has stock; otherwise offer
// the first unit that does. Returns the default when none has stock, so the
// caller's "out of stock" message still names the usual unit.
export function chooseSellableUnit(product = {}, units = [], defaultUnit = null) {
  const preferred = defaultUnit || units[0] || null
  if (!preferred || getAvailableStockUnits(product, preferred) > 0) return preferred
  return units.find((unit) => getAvailableStockUnits(product, unit) > 0) || preferred
}
