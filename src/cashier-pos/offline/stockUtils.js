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
