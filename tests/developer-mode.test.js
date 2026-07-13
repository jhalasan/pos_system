import test from 'node:test'
import assert from 'node:assert/strict'

const memoryStorage = (() => {
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
      Object.keys(store).forEach((itemKey) => delete store[itemKey])
    },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: memoryStorage,
  configurable: true,
})

import {
  DEFAULT_DEVELOPER_MODE_SETTINGS,
  getDeveloperModeSettings,
  isDeveloperApprovalBarcode,
  isDeveloperPinValid,
  saveDeveloperModeSettings,
  validateDeveloperBarcode,
} from '../src/utils/developerMode.js'

test('developer mode settings default to a disabled state', () => {
  memoryStorage.clear()
  const settings = getDeveloperModeSettings()
  assert.deepEqual(settings, DEFAULT_DEVELOPER_MODE_SETTINGS)
})

test('developer barcode validation uses configured barcode and pin', () => {
  memoryStorage.clear()
  saveDeveloperModeSettings({ developerBarcodeEnabled: true, developerBarcode: '0067', developerPin: '0067' })
  assert.equal(validateDeveloperBarcode('0067', '0067'), true)
  assert.equal(validateDeveloperBarcode('0067', '0000'), false)
  assert.equal(validateDeveloperBarcode('0000', '0067'), false)
})

test('developer PIN validation checks the configured PIN', () => {
  memoryStorage.clear()
  saveDeveloperModeSettings({ developerPin: '0067' })
  assert.equal(isDeveloperPinValid('0067'), true)
  assert.equal(isDeveloperPinValid('0000'), false)
})

test('developer approval barcode only works when developer mode and its barcode are enabled', () => {
  memoryStorage.clear()
  saveDeveloperModeSettings({ enabled: true, developerBarcodeEnabled: true, developerBarcode: '0067' })
  assert.equal(isDeveloperApprovalBarcode('0067'), true)
  assert.equal(isDeveloperApprovalBarcode('0000'), false)
  saveDeveloperModeSettings({ enabled: false })
  assert.equal(isDeveloperApprovalBarcode('0067'), false)
})
