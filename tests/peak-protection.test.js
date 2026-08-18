import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activatePeakProtection,
  getPeakProtectionSettings,
  peakProtectionConfig,
  peakProtectionStatus,
  recordCompletedSale,
  savePeakProtectionSettings,
} from '../src/utils/peakProtection.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('activates immediately after a short transaction burst and persists the safety window', () => {
  const storage = memoryStorage()
  const start = Date.UTC(2026, 7, 18, 4)
  recordCompletedSale({ itemCount: 2, pending: 1 }, { now: start, storage })
  recordCompletedSale({ itemCount: 2, pending: 2 }, { now: start + 20_000, storage })
  const result = recordCompletedSale({ itemCount: 2, pending: 3 }, { now: start + 40_000, storage })

  assert.equal(result.active, true)
  assert.ok(result.activeUntil >= start + 40_000 + peakProtectionConfig.minimumActiveMs)
  assert.equal(peakProtectionStatus({ now: start + 60_000, storage }).active, true)
})

test('a growing durable queue activates protection before a rate limit', () => {
  const storage = memoryStorage()
  const result = recordCompletedSale({ itemCount: 1, pending: peakProtectionConfig.queueThreshold }, {
    now: Date.UTC(2026, 7, 18, 4),
    storage,
  })
  assert.equal(result.active, true)
  assert.match(result.reason, /queue/i)
})

test('manual off disables automatic activation but never disables rate-limit safety', () => {
  const storage = memoryStorage()
  const now = Date.UTC(2026, 7, 18, 4)
  savePeakProtectionSettings({ mode: 'off' }, storage)
  const automatic = activatePeakProtection('busy', { now, storage })
  assert.equal(automatic.active, false)

  // Use the same safety path with injected state semantics to verify that
  // manual-off cannot suppress mandatory host protection.
  const state = activatePeakProtection('rate limited', { now, storage, safety: true })
  assert.equal(state.active, true)
  assert.equal(peakProtectionStatus({ now: now + 1, storage }).safetyActive, true)
})

test('settings are bounded before being persisted', () => {
  const storage = memoryStorage()
  savePeakProtectionSettings({ syncIntervalMinutes: 0, salesThreshold: 999 }, storage)
  const settings = getPeakProtectionSettings(storage)
  assert.equal(settings.syncIntervalMinutes, 1)
  assert.equal(settings.salesThreshold, 20)
})
