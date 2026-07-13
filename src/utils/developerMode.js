const DEVELOPER_MODE_STORAGE_KEY = 'nexa_developer_mode_settings'
let fallbackStorage = null

export const DEFAULT_DEVELOPER_MODE_SETTINGS = {
  enabled: false,
  requireCashDrawer: false,
  requireReceiptPrint: false,
  developerBarcodeEnabled: false,
  developerBarcode: '0067',
  developerPin: '0067',
}

function createMemoryStorage() {
  const store = {}
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    },
    setItem(key, value) {
      store[key] = String(value)
    },
    removeItem(key) {
      delete store[key]
    },
    clear() {
      Object.keys(store).forEach((key) => delete store[key])
    },
  }
}

function getStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage
  }
  if (!fallbackStorage) {
    fallbackStorage = createMemoryStorage()
  }
  return fallbackStorage
}

export function getDeveloperModeSettings() {
  try {
    const storedValue = getStorage().getItem(DEVELOPER_MODE_STORAGE_KEY)
    if (!storedValue) {
      return { ...DEFAULT_DEVELOPER_MODE_SETTINGS }
    }
    const parsed = JSON.parse(storedValue)
    return {
      ...DEFAULT_DEVELOPER_MODE_SETTINGS,
      ...parsed,
      developerBarcode: String(parsed?.developerBarcode ?? DEFAULT_DEVELOPER_MODE_SETTINGS.developerBarcode).trim() || DEFAULT_DEVELOPER_MODE_SETTINGS.developerBarcode,
      developerPin: String(parsed?.developerPin ?? DEFAULT_DEVELOPER_MODE_SETTINGS.developerPin).trim() || DEFAULT_DEVELOPER_MODE_SETTINGS.developerPin,
    }
  } catch {
    return { ...DEFAULT_DEVELOPER_MODE_SETTINGS }
  }
}

export function saveDeveloperModeSettings(patch = {}) {
  const nextSettings = {
    ...getDeveloperModeSettings(),
    ...patch,
  }
  getStorage().setItem(DEVELOPER_MODE_STORAGE_KEY, JSON.stringify(nextSettings))
  return nextSettings
}

export function validateDeveloperBarcode(barcode, pin) {
  const settings = getDeveloperModeSettings()
  if (!settings.developerBarcodeEnabled) {
    return false
  }
  return String(barcode || '').trim() === settings.developerBarcode && String(pin || '').trim() === settings.developerPin
}

export function isDeveloperPinValid(pin, settings = getDeveloperModeSettings()) {
  return String(pin || '').trim() === String(settings.developerPin || '').trim()
}

export function isDeveloperApprovalBarcode(barcode, settings = getDeveloperModeSettings()) {
  return Boolean(
    settings.enabled
    && settings.developerBarcodeEnabled
    && String(barcode || '').trim() === String(settings.developerBarcode || '').trim()
  )
}

export function isDeveloperModeEnabled() {
  return Boolean(getDeveloperModeSettings().enabled)
}
