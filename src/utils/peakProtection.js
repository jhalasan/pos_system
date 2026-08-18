const STORAGE_KEY = 'nexa_peak_protection_v1'
const ACTIVITY_WINDOW_MS = 2 * 60_000
const MIN_ACTIVE_MS = 10 * 60_000
const DEFAULT_CONFIG = {
  mode: 'automatic',
  salesThreshold: 3,
  itemsThreshold: 12,
  queueThreshold: 5,
  syncIntervalMinutes: 3,
  minimumActiveMinutes: 10,
}

function emptyState() {
  return { activeUntil: 0, safetyUntil: 0, reason: '', sales: [], history: {}, config: DEFAULT_CONFIG }
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

function normalizeConfig(config = {}) {
  return {
    mode: ['automatic', 'on', 'off'].includes(config.mode) ? config.mode : DEFAULT_CONFIG.mode,
    salesThreshold: boundedNumber(config.salesThreshold, DEFAULT_CONFIG.salesThreshold, 2, 20),
    itemsThreshold: boundedNumber(config.itemsThreshold, DEFAULT_CONFIG.itemsThreshold, 5, 100),
    queueThreshold: boundedNumber(config.queueThreshold, DEFAULT_CONFIG.queueThreshold, 2, 50),
    syncIntervalMinutes: boundedNumber(config.syncIntervalMinutes, DEFAULT_CONFIG.syncIntervalMinutes, 1, 15),
    minimumActiveMinutes: boundedNumber(config.minimumActiveMinutes, DEFAULT_CONFIG.minimumActiveMinutes, 5, 60),
  }
}

function activityBucket(now) {
  const date = new Date(now)
  const bucket = Math.floor((date.getHours() * 60 + date.getMinutes()) / 15)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}|${date.getDay()}|${bucket}`
}

function pruneHistory(history, now) {
  const cutoff = now - 35 * 24 * 60 * 60_000
  return Object.fromEntries(Object.entries(history || {}).filter(([key]) => {
    const [date] = key.split('|')
    return new Date(`${date} 00:00:00`).getTime() >= cutoff
  }))
}

function readState(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null')
    return parsed && typeof parsed === 'object'
      ? { ...emptyState(), ...parsed, config: normalizeConfig(parsed.config) }
      : emptyState()
  } catch {
    return emptyState()
  }
}

function writeState(state, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* keep checkout available */ }
}

function announce(state, pending = 0) {
  if (typeof globalThis.CustomEvent !== 'function') return
  globalThis.dispatchEvent?.(new CustomEvent('nexa-sync-status', {
    detail: {
      scope: 'cashier',
      state: 'peak-protection',
      message: `Peak Protection Active — checkout is operating normally. ${pending} transaction(s) safely queued.`,
    },
  }))
  globalThis.dispatchEvent?.(new CustomEvent('nexa-peak-protection', { detail: state }))
}

export function peakProtectionStatus({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  const state = readState(storage)
  const forced = state.config.mode === 'on'
  const safetyActive = Number(state.safetyUntil) > now
  const automaticActive = state.config.mode === 'automatic' && Number(state.activeUntil) > now
  return { ...state, active: forced || safetyActive || automaticActive, safetyActive }
}

export function getPeakProtectionSettings(storage = globalThis.localStorage) {
  return readState(storage).config
}

export function savePeakProtectionSettings(patch, storage = globalThis.localStorage) {
  const state = readState(storage)
  const config = normalizeConfig({ ...state.config, ...patch })
  const next = { ...state, config }
  writeState(next, storage)
  if (typeof globalThis.CustomEvent === 'function') {
    globalThis.dispatchEvent?.(new CustomEvent('nexa-peak-protection-settings', { detail: config }))
  }
  if (config.mode === 'on') announce(next, 0)
  return config
}

export function activatePeakProtection(reason, {
  pending = 0,
  now = Date.now(),
  storage = globalThis.localStorage,
  safety = false,
} = {}) {
  const state = readState(storage)
  if (!safety && state.config.mode === 'off') return { ...state, active: false }
  const durationMs = state.config.minimumActiveMinutes * 60_000
  const next = {
    ...state,
    reason: String(reason || 'High transaction activity detected.'),
    activeUntil: Math.max(Number(state.activeUntil) || 0, now + durationMs),
    safetyUntil: safety ? Math.max(Number(state.safetyUntil) || 0, now + durationMs) : state.safetyUntil,
  }
  writeState(next, storage)
  announce(next, pending)
  return { ...next, active: true }
}

export function recordCompletedSale({ itemCount = 0, pending = 0 } = {}, {
  now = Date.now(),
  storage = globalThis.localStorage,
} = {}) {
  const state = readState(storage)
  const cutoff = now - ACTIVITY_WINDOW_MS
  const sales = [...(Array.isArray(state.sales) ? state.sales : []), { at: now, items: Number(itemCount) || 0 }]
    .filter((sale) => Number(sale.at) >= cutoff)
  const items = sales.reduce((total, sale) => total + (Number(sale.items) || 0), 0)
  const next = { ...state, sales }
  const history = pruneHistory(state.history, now)
  const bucket = activityBucket(now)
  history[bucket] = (Number(history[bucket]) || 0) + 1
  next.history = history
  writeState(next, storage)

  const config = state.config
  if (config.mode === 'on') return activatePeakProtection('Peak Protection was turned on manually.', { pending, now, storage })
  if (config.mode === 'automatic' && (sales.length >= config.salesThreshold || items >= config.itemsThreshold || pending >= config.queueThreshold)) {
    const reason = pending >= config.queueThreshold
      ? 'The transaction queue is growing.'
      : 'High transaction activity was detected.'
    return activatePeakProtection(reason, { pending, now, storage })
  }
  return { ...next, active: Number(next.activeUntil) > now }
}

export function isPredictedPeak({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  const state = readState(storage)
  const [, weekday, bucket] = activityBucket(now).split('|')
  const matchingDays = Object.entries(state.history || {})
    .filter(([key]) => {
      const [, historicalWeekday, historicalBucket] = key.split('|')
      return historicalWeekday === weekday && historicalBucket === bucket
    })
    .map(([, count]) => Number(count) || 0)
  return matchingDays.length >= 2
    && matchingDays.reduce((sum, count) => sum + count, 0) / matchingDays.length >= state.config.salesThreshold
}

export function protectAfterCloudPressure(reason, pending = 0) {
  return activatePeakProtection(reason || 'Cloud synchronization is under pressure.', { pending, safety: true })
}

export const peakProtectionConfig = {
  activityWindowMs: ACTIVITY_WINDOW_MS,
  minimumActiveMs: MIN_ACTIVE_MS,
  ...DEFAULT_CONFIG,
}
