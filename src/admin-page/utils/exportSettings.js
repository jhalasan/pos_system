export const exportLocationKeys = {
  activityLogs: 'activityLogs',
  reports: 'reports',
  products: 'products',
}

const storageKey = 'nexa-pos-export-locations'

const defaultLocations = {
  [exportLocationKeys.activityLogs]: '',
  [exportLocationKeys.reports]: '',
  [exportLocationKeys.products]: '',
}

export const exportLocationLabels = {
  [exportLocationKeys.activityLogs]: 'Activity Logs',
  [exportLocationKeys.reports]: 'Reports',
  [exportLocationKeys.products]: 'Products',
}

export function getExportLocations() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return { ...defaultLocations, ...stored }
  } catch {
    return { ...defaultLocations }
  }
}

export function saveExportLocations(locations) {
  const next = { ...defaultLocations, ...locations }
  localStorage.setItem(storageKey, JSON.stringify(next))
  return next
}

export function getExportLocation(type) {
  return getExportLocations()[type] || ''
}
