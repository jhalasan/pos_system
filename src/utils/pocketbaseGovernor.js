// Paced access to PocketHost: a token-bucket + AIMD rate governor with an
// escalating cooldown on 429s, priority lanes, a keyed single-flight
// dedupe, and cross-window persistence via an injected `storage`.
//
// This module is purely additive — nothing in the app wires it in yet.
// It is intended to eventually replace the reactive-only cooldown in
// `pocketbaseRateLimit.js` (a later task), which currently only reacts to a
// 429 after the fact with a flat 5-minute guess and has a shared (not
// keyed) single-flight slot.

const RATE_START = 2 // requests/second
const RATE_FLOOR = 0.4
const RATE_CEILING = 8
const BURST = 5 // max tokens in the bucket (bounds concurrency, not just sustained rate)

const ADDITIVE_INCREASE_STEP = 0.25
const ADDITIVE_INCREASE_WINDOW_MS = 10_000 // clean-period (no active cooldown) window for AIMD rate increase
const MULTIPLICATIVE_DECREASE_FACTOR = 0.5

const BASE_COOLDOWN_MS = 20_000 // first 429 after a clean period
const MAX_COOLDOWN_MS = 5 * 60_000 // escalation ceiling, not a flat default anymore

const MAX_BACKGROUND_DEPTH = 3

const DEFAULT_KEY = 'nexa_pb_governor'

function retryMsFromError(error) {
  const retryAfter = Number(error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a governor instance. Each instance owns its own in-memory state
 * (refilled/adjusted lazily on each call) and, when `storage` is available,
 * mirrors that state to `storage[key]` so multiple windows/tabs on one
 * machine share one bucket. A benign lost-update race across windows on
 * concurrent read-modify-write is accepted — no cross-window locking.
 */
export function createGovernor({ now = Date.now, storage = globalThis.localStorage, key = DEFAULT_KEY } = {}) {
  let state = {
    rate: RATE_START,
    tokens: BURST,
    lastRefillAt: now(),
    rateLimitedUntil: 0,
    consecutive429: 0,
    lastCleanCheckAt: now(),
    updatedAt: now(),
  }

  const backgroundWaiters = { count: 0 }
  const singleFlightSlots = new Map()

  function readStorage() {
    if (!storage) return null
    try {
      const raw = storage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  function writeStorage() {
    if (!storage) return
    try {
      storage.setItem(key, JSON.stringify({
        rate: state.rate,
        tokens: state.tokens,
        lastRefillAt: state.lastRefillAt,
        rateLimitedUntil: state.rateLimitedUntil,
        consecutive429: state.consecutive429,
        updatedAt: state.updatedAt,
      }))
    } catch {
      // Full/unavailable localStorage (private browsing, quota) degrades to
      // in-memory-only behavior — never throw from the request path.
    }
  }

  /**
   * Picks up the safety-critical parts of another window's state: an
   * active (or longer) cooldown, and a rate no higher than what another
   * window has already backed off to. This deliberately does NOT adopt
   * `tokens`/`lastRefillAt` from storage — those stay purely local to this
   * instance's own in-memory bucket math.
   *
   * Two reasons for that split: (1) wall-clock `updatedAt` timestamps are
   * not fine-grained enough to reliably order writes (two calls can
   * legitimately touch state within the same millisecond, especially under
   * a fake/injected clock in tests), so there is no reliable way to tell
   * whether a persisted token count is newer or staler than the in-memory
   * one; and (2) several concurrent `schedule()` calls on the SAME
   * instance (e.g. a burst of background tasks) read-modify-write this
   * loop repeatedly while awaiting their own timers — wholesale-adopting a
   * stale persisted token count between those in-flight local refills was
   * found (via the token-bucket test) to erase progress a sibling call had
   * already computed in memory, moments before it persisted it. Keeping
   * tokens local avoids that self-inflicted race while still sharing the
   * one piece of state that actually matters for cross-window safety: stop
   * every window from calling PocketHost while any one of them is
   * rate-limited. A benign lost-update race on the shared cooldown fields
   * themselves is accepted by design (see module comment) — no locking.
   */
  function syncFromStorage() {
    const persisted = readStorage()
    if (!persisted) return

    const persistedRateLimitedUntil = Number(persisted.rateLimitedUntil) || 0
    if (persistedRateLimitedUntil > state.rateLimitedUntil) {
      state.rateLimitedUntil = persistedRateLimitedUntil
      state.consecutive429 = Number(persisted.consecutive429) || 0
    }

    const persistedRate = Number(persisted.rate)
    if (Number.isFinite(persistedRate) && persistedRate > 0 && persistedRate < state.rate) {
      state.rate = persistedRate
    }
  }

  if (storage && typeof globalThis.addEventListener === 'function') {
    try {
      globalThis.addEventListener('storage', (event) => {
        if (event?.key && event.key !== key) return
        syncFromStorage()
      })
    } catch {
      // Test/embedded environments may not support addEventListener the
      // way browsers do — pacing still works from this window's own state.
    }
  }

  function refill() {
    const nowMs = now()
    const elapsedMs = Math.max(0, nowMs - state.lastRefillAt)
    if (elapsedMs > 0) {
      state.tokens = Math.min(BURST, state.tokens + (elapsedMs / 1000) * state.rate)
      state.lastRefillAt = nowMs
    }

    // AIMD additive increase: after 10s with no active cooldown, nudge the
    // rate up. This is purely time-based (per the brief), and deliberately
    // does NOT reset consecutive429 — see recordSuccess() for why.
    if (nowMs - state.lastCleanCheckAt >= ADDITIVE_INCREASE_WINDOW_MS) {
      if (state.rateLimitedUntil <= nowMs) {
        state.rate = Math.min(RATE_CEILING, state.rate + ADDITIVE_INCREASE_STEP)
      }
      state.lastCleanCheckAt = nowMs
    }
  }

  function touch() {
    state.updatedAt = now()
    writeStorage()
  }

  function isRateLimited() {
    syncFromStorage()
    return state.rateLimitedUntil > now()
  }

  function remainingMs() {
    syncFromStorage()
    return Math.max(0, state.rateLimitedUntil - now())
  }

  function message() {
    const remaining = remainingMs()
    const minutes = Math.max(1, Math.ceil(remaining / 60_000))
    return `PocketHost rate limit reached. Try again in about ${minutes} minute(s).`
  }

  function recordSuccess() {
    syncFromStorage()
    refill()
    // The 429 streak must only reset once a request has actually
    // succeeded — never merely because a cooldown elapsed and pacing
    // resumed (refill() runs on every schedule() call, including the very
    // first retry attempt after a cooldown clears, before its outcome is
    // known). Resetting there would make consecutive429 re-arm at the 20s
    // floor on every retry against a real, persistent lockout, instead of
    // escalating — defeating the point of the escalating cooldown.
    state.consecutive429 = 0
    touch()
  }

  function recordRateLimit(error) {
    syncFromStorage()
    refill()

    state.rate = Math.max(RATE_FLOOR, state.rate * MULTIPLICATIVE_DECREASE_FACTOR)
    state.consecutive429 += 1

    const explicitMs = retryMsFromError(error)
    const escalatedMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * (2 ** (state.consecutive429 - 1)))
    const cooldownMs = explicitMs != null ? Math.min(MAX_COOLDOWN_MS, explicitMs) : escalatedMs

    const nowMs = now()
    state.rateLimitedUntil = Math.max(state.rateLimitedUntil, nowMs + cooldownMs)
    state.lastCleanCheckAt = nowMs
    touch()
  }

  async function waitForCooldown() {
    // Loop instead of a single wait: another window may extend the
    // cooldown (or another local recordRateLimit could fire) while we
    // sleep, and syncFromStorage picks that up on each pass.
    for (;;) {
      syncFromStorage()
      const remaining = state.rateLimitedUntil - now()
      if (remaining <= 0) return
      await sleep(remaining)
    }
  }

  async function waitForToken() {
    for (;;) {
      syncFromStorage()
      refill()
      if (state.tokens >= 1) return
      const deficit = 1 - state.tokens
      const waitMs = Math.max(1, Math.ceil((deficit / state.rate) * 1000))
      touch()
      await sleep(waitMs)
    }
  }

  async function schedule(task, { priority = 'interactive', label } = {}) {
    void label // reserved for future diagnostics/telemetry, not used yet

    if (priority === 'background') {
      if (backgroundWaiters.count >= MAX_BACKGROUND_DEPTH) {
        const err = new Error('PocketHost pacer: too many background tasks already waiting.')
        err.code = 'PACER_DEFERRED'
        throw err
      }
      backgroundWaiters.count += 1
      try {
        await waitForCooldown()
        await waitForToken()
      } finally {
        backgroundWaiters.count -= 1
      }
    } else if (priority === 'write') {
      await waitForCooldown()
      await waitForToken()
    } else {
      // interactive: never blocked by pacing — only wait out an active
      // cooldown. It still draws from the bucket below like every other
      // priority (the shared tail past this if/else), it just never calls
      // waitForToken() to wait for one. Math.max(0, tokens - 1) floors at
      // 0 rather than going negative, so a burst of interactive calls past
      // BURST still fully depletes the bucket (visible to, and correctly
      // paced by, any write/background call that follows) — it just can't
      // track exactly how far over-burst the caller went, which is fine
      // since the bucket being at its floor already produces the longest
      // wait write/background pacing computes.
      await waitForCooldown()
    }

    syncFromStorage()
    refill()
    state.tokens = Math.max(0, state.tokens - 1)
    touch()

    return task()
  }

  function singleFlight(flightKey, task) {
    if (singleFlightSlots.has(flightKey)) return singleFlightSlots.get(flightKey)
    // Invoke `task` synchronously (matching the pattern already used by
    // pocketbaseRateLimit.js's withPocketBaseRateLimitLock) so the slot is
    // occupied before control returns to the caller — two synchronous,
    // back-to-back calls with the same key must still share one flight.
    const promise = Promise.resolve(task()).finally(() => {
      singleFlightSlots.delete(flightKey)
    })
    singleFlightSlots.set(flightKey, promise)
    return promise
  }

  function reset() {
    state = {
      rate: RATE_START,
      tokens: BURST,
      lastRefillAt: now(),
      rateLimitedUntil: 0,
      consecutive429: 0,
      lastCleanCheckAt: now(),
      updatedAt: now(),
    }
    backgroundWaiters.count = 0
    singleFlightSlots.clear()
    if (storage) {
      try {
        storage.removeItem(key)
      } catch {
        // ignore — same degrade-to-memory posture as writeStorage()
      }
    }
  }

  return {
    schedule,
    recordSuccess,
    recordRateLimit,
    isRateLimited,
    remainingMs,
    message,
    singleFlight,
    reset,
  }
}
