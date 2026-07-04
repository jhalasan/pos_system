export function toBaseStockQuantity(quantity, conversion = 1) {
  const normalizedQuantity = Number(quantity) || 0
  const normalizedConversion = Number(conversion) > 0 ? Number(conversion) : 1
  return normalizedQuantity * normalizedConversion
}
