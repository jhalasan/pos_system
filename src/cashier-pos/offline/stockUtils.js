export function toBaseStockQuantity(quantity, conversion = 1) {
  const normalizedQuantity = Number(quantity) || 0
  const normalizedConversion = Number(conversion) > 0 ? Number(conversion) : 1
  return normalizedQuantity * normalizedConversion
}

export function getStockQuantity(product = {}) {
  const quantity = Number(product?.quantity ?? product?.qty ?? 0) || 0
  return Math.max(0, quantity)
}

export function getAvailableStockUnits(product = {}, unit = {}) {
  const stockQty = getStockQuantity(product)
  const conversion = Number(unit?.conversion ?? unit?.conversionQuantity ?? product?.conversion ?? 1) || 1
  if (conversion <= 0) return 0
  return Math.max(0, Math.floor(stockQty / conversion))
}
