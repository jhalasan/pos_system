import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createGovernor } from '../src/utils/pocketbaseGovernor.js'

// Unit coverage for the standalone pacing governor: token-bucket refill,
// AIMD rate adjustment, escalating cooldown, priority lanes, keyed
// single-flight, and cross-window persistence via an injected storage
// object. Everything here uses an injected `now` plus node:test's fake
// setTimeout so timing is deterministic — no real waiting, no busy-polling.

function makeClock(start = 0) {
  let value = start
  return {
    now: () => value,
    advance(ms) { value += ms },
  }
}

function makeStorage() {
  const data = new Map()
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  }
}

function rateLimitError({ retryAfterSeconds } = {}) {
  const err = new Error('Something went wrong.')
  err.status = 429
  if (retryAfterSeconds != null) err.headers = { 'retry-after': String(retryAfterSeconds) }
  return err
}

/** Advances both the injected clock and the fake timer engine together. */
function advanceTogether(clock, ms) {
  clock.advance(ms)
  mock.timers.tick(ms)
}

/**
 * schedule() is async and its first bucket/cooldown check runs a couple of
 * microtask hops after being called (through the internal
 * waitForCooldown -> waitForToken chain), not synchronously. Tests that
 * schedule a task and then immediately advance the fake clock must drain
 * the microtask queue first, or that first check ends up running "in the
 * future" relative to where the test believes the clock is.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

test('token bucket: interactive tasks run immediately even with an empty bucket (never blocked by pacing)', { concurrency: false }, async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-interactive' })

  const calls = []
  for (let i = 0; i < 7; i += 1) {
    await governor.schedule(async () => { calls.push(i) }, { priority: 'interactive' })
  }

  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6], 'all 7 interactive tasks ran, well past the 5-token burst cap')
})

test('token bucket: a write task is paced and waits for a token to refill', { concurrency: false }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const clock = makeClock()
    const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-write-pacing' })

    // Drain the 5-token burst with interactive calls (rate stays at the
    // RATE_START of 2/s throughout, since no time has passed).
    for (let i = 0; i < 5; i += 1) {
      await governor.schedule(async () => {}, { priority: 'interactive' })
    }

    let ran = false
    const pending = governor.schedule(async () => { ran = true; return 'ok' }, { priority: 'write' })
    await flushMicrotasks()

    // At 2 req/s, refilling 1 token takes 500ms. Just under that, the task
    // must still be waiting.
    advanceTogether(clock, 499)
    await Promise.resolve()
    assert.equal(ran, false, 'must not run before a token has refilled')

    advanceTogether(clock, 1)
    const result = await pending
    assert.equal(ran, true)
    assert.equal(result, 'ok', 'schedule resolves with the task return value')
  } finally {
    mock.timers.reset()
  }
})

test('AIMD: 10 clean seconds nudges the rate up, refilling the next token faster', { concurrency: false }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const clock = makeClock()
    const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-aimd-increase' })

    for (let i = 0; i < 5; i += 1) {
      await governor.schedule(async () => {}, { priority: 'interactive' })
    }

    // A clean 10s window (no 429s) bumps rate from 2 -> 2.25 and, since the
    // bucket was already empty, refills it back to full (well above 1
    // token) as a side effect of the elapsed time.
    advanceTogether(clock, 10_000)
    governor.recordSuccess()

    // Drain the now-full bucket back down to empty without letting any
    // further time pass, so the next wait measurement is clean.
    for (let i = 0; i < 5; i += 1) {
      await governor.schedule(async () => {}, { priority: 'interactive' })
    }

    let ran = false
    const pending = governor.schedule(async () => { ran = true }, { priority: 'write' })
    await flushMicrotasks()

    // At the new rate of 2.25/s, one token takes ceil(1000/2.25) = 445ms.
    advanceTogether(clock, 444)
    await Promise.resolve()
    assert.equal(ran, false, 'must still be waiting one ms before the faster refill completes')
    advanceTogether(clock, 1)
    await pending
    assert.equal(ran, true, 'the increased rate must refill faster than the original 500ms')
  } finally {
    mock.timers.reset()
  }
})

test('AIMD: a 429 halves the rate, so the next token refill takes longer', { concurrency: false }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const clock = makeClock()
    const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-aimd-decrease' })

    for (let i = 0; i < 5; i += 1) {
      await governor.schedule(async () => {}, { priority: 'interactive' })
    }

    // A short, explicit retry-after keeps the cooldown well under the 10s
    // clean-period window, so this test isolates the multiplicative
    // decrease from the additive-increase reset.
    governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 1 }))
    assert.equal(governor.isRateLimited(), true)

    advanceTogether(clock, 1000)
    assert.equal(governor.isRateLimited(), false, 'the short explicit cooldown must have cleared')

    // One interactive call to burn the single token that refilled during
    // the 1s cooldown wait (rate is now 1.0/s), leaving the bucket empty.
    await governor.schedule(async () => {}, { priority: 'interactive' })

    let ran = false
    const pending = governor.schedule(async () => { ran = true }, { priority: 'write' })
    await flushMicrotasks()

    // At the halved rate of 1.0/s, one token takes 1000ms - double the
    // original 500ms.
    advanceTogether(clock, 999)
    await Promise.resolve()
    assert.equal(ran, false)
    advanceTogether(clock, 1)
    await pending
    assert.equal(ran, true)
  } finally {
    mock.timers.reset()
  }
})

test('escalating cooldown: doubles per consecutive 429 starting at 20s, capped at 5 minutes', { concurrency: false }, async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-escalation' })

  governor.recordRateLimit(rateLimitError())
  assert.equal(governor.remainingMs(), 20_000, 'first 429 in a clean period starts at 20s')

  governor.recordRateLimit(rateLimitError())
  assert.equal(governor.remainingMs(), 40_000, 'second consecutive 429 doubles to 40s')

  governor.recordRateLimit(rateLimitError())
  assert.equal(governor.remainingMs(), 80_000, 'third consecutive 429 doubles again to 80s')

  governor.recordRateLimit(rateLimitError())
  governor.recordRateLimit(rateLimitError())
  governor.recordRateLimit(rateLimitError())
  assert.equal(governor.remainingMs(), 300_000, 'escalation is capped at the 5-minute ceiling')
})

test('an explicit retry-after header overrides the escalating cooldown guess', { concurrency: false }, async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-retry-after' })

  governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 90 }))
  assert.equal(governor.remainingMs(), 90_000)
})

test('isRateLimited / remainingMs / message reflect an active cooldown and clear afterward', { concurrency: false }, async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-message' })

  assert.equal(governor.isRateLimited(), false)
  assert.equal(governor.remainingMs(), 0)

  governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 125 }))
  assert.equal(governor.isRateLimited(), true)
  assert.match(governor.message(), /PocketHost rate limit reached\. Try again in about 3 minute\(s\)\./)

  clock.advance(125_000)
  assert.equal(governor.isRateLimited(), false)
  assert.equal(governor.remainingMs(), 0)
})

test('schedule: write and interactive tasks wait out an active cooldown before running', { concurrency: false }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const clock = makeClock()
    const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-cooldown-wait' })

    governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 5 }))

    let ran = false
    const pending = governor.schedule(async () => { ran = true }, { priority: 'interactive' })
    await flushMicrotasks()

    advanceTogether(clock, 4999)
    await Promise.resolve()
    assert.equal(ran, false, 'even an interactive task must not run during an active cooldown')

    advanceTogether(clock, 1)
    await pending
    assert.equal(ran, true)
  } finally {
    mock.timers.reset()
  }
})

test('background priority: paced last and rejected past MAX_BACKGROUND_DEPTH instead of queuing indefinitely', { concurrency: false }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const clock = makeClock()
    const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-background-depth' })

    for (let i = 0; i < 5; i += 1) {
      await governor.schedule(async () => {}, { priority: 'interactive' })
    }

    const ran = [false, false, false]
    const p1 = governor.schedule(async () => { ran[0] = true }, { priority: 'background', label: 'p1' })
    const p2 = governor.schedule(async () => { ran[1] = true }, { priority: 'background', label: 'p2' })
    const p3 = governor.schedule(async () => { ran[2] = true }, { priority: 'background', label: 'p3' })

    await assert.rejects(
      governor.schedule(async () => {}, { priority: 'background' }),
      (err) => err.code === 'PACER_DEFERRED',
      'a 4th background task must be rejected immediately once 3 are already waiting',
    )
    await flushMicrotasks()

    advanceTogether(clock, 2000)
    await Promise.all([p1, p2, p3])
    assert.deepEqual(ran, [true, true, true], 'the 3 accepted background tasks must eventually run once tokens refill')

    // The depth slot must be freed up again once those tasks finished.
    let fourthRan = false
    await governor.schedule(async () => { fourthRan = true }, { priority: 'background' })
    assert.equal(fourthRan, true)
  } finally {
    mock.timers.reset()
  }
})

test('singleFlight: the same key in-flight returns the same promise; different keys never share a slot', { concurrency: false }, async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-single-flight' })

  let callsA = 0
  let callsB = 0
  let resolveA
  const taskA = () => new Promise((resolve) => { callsA += 1; resolveA = resolve })
  const taskB = async () => { callsB += 1; return 'b-result' }

  const first = governor.singleFlight('refresh-catalog', taskA)
  const second = governor.singleFlight('refresh-catalog', taskA)
  assert.equal(first, second, 'the same key while in-flight must return the exact same promise')
  assert.equal(callsA, 1, 'the underlying task must only run once for concurrent same-key calls')

  const otherKey = governor.singleFlight('refresh-something-else', taskB)
  assert.equal(await otherKey, 'b-result', 'a different key must run its own task, not share the first slot')
  assert.equal(callsB, 1)

  resolveA('a-result')
  assert.equal(await first, 'a-result')

  // Once settled, the same key must be free to start a fresh flight.
  let callsAAfter = 0
  const third = governor.singleFlight('refresh-catalog', async () => { callsAAfter += 1; return 'a-result-2' })
  assert.equal(await third, 'a-result-2')
  assert.equal(callsAAfter, 1)
})

test('cross-window persistence: a cooldown recorded by one governor is visible to another sharing the same storage', { concurrency: false }, async () => {
  const clock = makeClock()
  const sharedStorage = makeStorage()

  const windowA = createGovernor({ now: clock.now, storage: sharedStorage, key: 'test-cross-window' })
  const windowB = createGovernor({ now: clock.now, storage: sharedStorage, key: 'test-cross-window' })

  assert.equal(windowB.isRateLimited(), false)

  windowA.recordRateLimit(rateLimitError({ retryAfterSeconds: 45 }))
  assert.equal(windowB.isRateLimited(), true, 'window B must pick up the cooldown window A just wrote to shared storage')
  assert.equal(windowB.remainingMs(), 45_000)

  clock.advance(45_000)
  assert.equal(windowA.isRateLimited(), false)
  assert.equal(windowB.isRateLimited(), false)
})

test('cross-window persistence: a storage event on another window is picked up via the listener, not just direct calls', { concurrency: false }, async () => {
  const clock = makeClock()
  const sharedStorage = makeStorage()
  let capturedHandler = null
  const originalAddEventListener = globalThis.addEventListener
  globalThis.addEventListener = (type, handler) => {
    if (type === 'storage') capturedHandler = handler
  }

  try {
    const governor = createGovernor({ now: clock.now, storage: sharedStorage, key: 'test-storage-event' })
    assert.equal(typeof capturedHandler, 'function', 'the governor must register a storage listener when addEventListener exists')

    // Simulate another window writing a cooldown directly to the shared
    // storage, then firing the browser's cross-tab 'storage' event.
    sharedStorage.setItem('test-storage-event', JSON.stringify({
      rate: 2, tokens: 5, lastRefillAt: 0, rateLimitedUntil: 60_000, consecutive429: 1, updatedAt: 1,
    }))
    capturedHandler({ key: 'test-storage-event' })

    assert.equal(governor.isRateLimited(), true, 'the listener-driven sync must reflect the other window\'s cooldown')
    assert.equal(governor.remainingMs(), 60_000)
  } finally {
    if (originalAddEventListener) globalThis.addEventListener = originalAddEventListener
    else delete globalThis.addEventListener
  }
})

test('storage unavailable: a throwing storage degrades to in-memory-only behavior instead of throwing', { concurrency: false }, async () => {
  const clock = makeClock()
  const throwingStorage = {
    getItem() { throw new Error('quota exceeded') },
    setItem() { throw new Error('quota exceeded') },
    removeItem() { throw new Error('quota exceeded') },
  }
  const governor = createGovernor({ now: clock.now, storage: throwingStorage, key: 'test-throwing-storage' })

  // Schedule while NOT rate limited, so this only exercises the
  // storage-write degradation path (a cooldown is covered separately
  // below and would otherwise make this test wait out a real 30s timer).
  const result = await governor.schedule(async () => 'ok', { priority: 'interactive' })
  assert.equal(result, 'ok', 'schedule must still complete normally when storage always throws')

  assert.doesNotThrow(() => governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 30 })))
  assert.equal(governor.isRateLimited(), true, 'in-memory state must still work even when storage always throws')
  assert.equal(governor.remainingMs(), 30_000)

  assert.doesNotThrow(() => governor.reset())
})

test('reset clears cooldown, rate, and single-flight state', { concurrency: false }, async () => {
  const clock = makeClock()
  const storage = makeStorage()
  const governor = createGovernor({ now: clock.now, storage, key: 'test-reset' })

  governor.recordRateLimit(rateLimitError({ retryAfterSeconds: 60 }))
  assert.equal(governor.isRateLimited(), true)

  let flightRuns = 0
  const inFlight = governor.singleFlight('k', () => new Promise(() => { flightRuns += 1 }))
  void inFlight

  governor.reset()

  assert.equal(governor.isRateLimited(), false)
  assert.equal(governor.remainingMs(), 0)
  assert.equal(storage.getItem('test-reset'), null, 'reset must also clear the persisted storage entry')

  // A fresh singleFlight call for the same key after reset must start a new
  // flight rather than returning the pre-reset pending promise (which
  // already started running once, but reset() drops the slot tracking it,
  // so it can never be returned to a caller again).
  let secondCalls = 0
  const secondResult = await governor.singleFlight('k', async () => { secondCalls += 1; return 'done' })
  assert.equal(secondCalls, 1)
  assert.equal(secondResult, 'done')
  assert.equal(flightRuns, 1, 'the pre-reset flight had already started once, as expected, but is now orphaned')
})
