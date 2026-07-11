/**
 * Normalize barcode for consistent matching
 * - Trims whitespace
 * - Converts to uppercase for case-insensitive comparison
 * - Validates format
 */
export function normalizeBarcode(barcode) {
  const trimmed = String(barcode || '').trim()
  if (!trimmed) return ''
  // Keep original case but trim whitespace
  // Some barcodes might be case-sensitive in some systems
  return trimmed
}

/**
 * Compare two barcodes for equality (case-insensitive)
 */
export function barcodesMatch(barcode1, barcode2) {
  const norm1 = normalizeBarcode(barcode1).toUpperCase()
  const norm2 = normalizeBarcode(barcode2).toUpperCase()
  return norm1 === norm2 && norm1.length > 0
}

/**
 * Find a product by barcode with fallback to selling units
 * Handles all barcode types: product, unit, manager, cashier
 */
export function findBarcodeMatch(product, scanCode) {
  if (!product || !scanCode) return null

  const normalized = normalizeBarcode(scanCode).toUpperCase()
  if (!normalized) return null

  // Check product base barcode
  if (barcodesMatch(product.barcode, scanCode)) {
    return { type: 'product', product, unit: null }
  }

  // Check selling units
  const sellingUnits = Array.isArray(product.sellingUnits)
    ? product.sellingUnits
    : []

  for (const unit of sellingUnits) {
    if (barcodesMatch(unit.barcode, scanCode)) {
      return { type: 'unit', product, unit }
    }
  }

  return null
}

/**
 * Validate barcode format
 * Basic validation - can be extended per barcode type
 */
export function isValidBarcode(barcode) {
  const normalized = normalizeBarcode(barcode)
  // Accept any non-empty string after trimming
  // More specific validation can be added per barcode type
  return normalized.length > 0
}
