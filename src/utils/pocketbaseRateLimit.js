// Thin facade over the shared pocketbaseGovernor instance. This module used
// to own its own reactive-only cooldown state (a flat 5-minute guess after a
// 429, plus an unkeyed single-flight slot) — it now delegates everything to
// the governor (token-bucket pacing, AIMD, escalating cooldown, keyed
// single-flight, cross-window persistence), while keeping the exact same
// exported surface so no existing caller needs to change.
import { sharedGovernor } from './pocketbaseGovernorInstance'

function textFromError(error) {
  return [
    error?.response?.message,
    error?.data?.message,
    error?.message,
    String(error || ''),
  ].filter(Boolean).join(' ')
}

/** Pure detection heuristic — kept independent of the governor, which only
 * ever receives errors already known to be 429s via `recordRateLimit`. */
export function isPocketBaseRateLimit(error) {
  return Number(error?.status) === 429 || /too many requests|rate.?limit|retry after/i.test(textFromError(error))
}

export function rememberPocketBaseRateLimit(error) {
  if (!isPocketBaseRateLimit(error)) return false
  sharedGovernor.recordRateLimit(error)
  return true
}

/** Deprecated alias for the governor's keyed single-flight, kept for
 * existing callers (cloudBootstrap.js in both apps) — a later task migrates
 * those to a proper keyed `singleFlight` call. */
export function withPocketBaseRateLimitLock(task) {
  return sharedGovernor.singleFlight('legacy', task)
}

export function pocketBaseRateLimitRemainingMs() {
  return sharedGovernor.remainingMs()
}

export function isPocketBaseRateLimited() {
  return sharedGovernor.isRateLimited()
}

export function pocketBaseRateLimitMessage() {
  return sharedGovernor.message()
}

/** Test-only: clears the shared governor's state so suites don't leak into each other. */
export function resetPocketBaseRateLimit() {
  sharedGovernor.reset()
}
