export function amountAfter(label, detail = '') {
  const pattern = new RegExp(`${label}\s+PHP\s*([+-]?[\d,.]+)`, 'i')
  const match = String(detail).match(pattern)
  return match ? Number(match[1].replace(/,/g, '')) || 0 : 0
}

export function countModeFromDetail(detail = '') {
  const detailText = String(detail || '')
  const match = detailText.match(/count\s+mode:\s*([a-z-]+)/i)
  return match ? match[1].trim().toLowerCase() : ''
}

export function hasAdminOverrideMarker(detail = '') {
  return /admin\s+override:\s*(admin|true|approved)/i.test(String(detail || ''))
}

export function isAdminOverride(detail = '') {
  const detailText = String(detail || '')
  return hasAdminOverrideMarker(detailText) || countModeFromDetail(detailText) === 'admin-override'
}

export function deriveVariance(actualValue, expectedValue, detail = '') {
  const parsedVariance = amountAfter('variance', detail)
  if (Number.isFinite(parsedVariance) && Math.abs(parsedVariance) > 0.000001) {
    return parsedVariance
  }
  if (Number.isFinite(actualValue) && Number.isFinite(expectedValue)) {
    return actualValue - expectedValue
  }
  return 0
}
