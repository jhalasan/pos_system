import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionHealer,
  HEAL_DELAYS_MS,
  HEAL_STOP_COOLDOWN_MS,
  healDelayMs,
} from '../src/cashier-pos/utils/sessionHealer.js'

// A fake clock: timers only fire when the test advances time, and every
// advance lets the async attempt chain settle before moving on.
function fakeClock() {
  let nowMs = 1_000_000
  let nextId = 0
  const timers = new Map()
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  return {
    now: () => nowMs,
    schedule(fn, ms) {
      const id = ++nextId
      timers.set(id, { at: nowMs + ms, fn })
      return id
    },
    cancel(id) { timers.delete(id) },
    pending: () => timers.size,
    async advance(ms) {
      const target = nowMs + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        nowMs = due[1].at
        timers.delete(due[0])
        due[1].fn()
        await settle()
      }
      nowMs = target
      await settle()
    },
  }
}

function setup(outcomes) {
  const clock = fakeClock()
  const calls = []
  const queue = [...outcomes]
  const healer = createSessionHealer({
    attempt: async (target, control) => {
      calls.push({ ...target, at: clock.now(), isCurrent: control.isCurrent })
      const next = queue.length ? queue.shift() : 'retry'
      return typeof next === 'function' ? next(control) : next
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
  })
  return { clock, calls, healer }
}

const CASHIER = { cashierId: 'cashier-1', barcode: '81000001' }

test('the first attempt waits 20 seconds, never fires early', async () => {
  const { clock, calls, healer } = setup([])
  assert.equal(healer.start(CASHIER), true)
  await clock.advance(19_999)
  assert.equal(calls.length, 0)
  await clock.advance(1)
  assert.equal(calls.length, 1)
  assert.deepEqual({ cashierId: calls[0].cashierId, barcode: calls[0].barcode }, CASHIER)
})

test('"immediate" starts right away (used when a live session has just expired)', async () => {
  const { clock, calls, healer } = setup([])
  healer.start(CASHIER, { immediate: true })
  await clock.advance(0)
  assert.equal(calls.length, 1)
})

test('retries back off 20s, 40s, 90s, 3min, then every 5 minutes -- gentle on the shared cloud login limit', async () => {
  const { clock, calls, healer } = setup([])
  healer.start(CASHIER)
  await clock.advance(20 * 60_000)
  const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at)
  assert.deepEqual(gaps.slice(0, 5), [40_000, 90_000, 180_000, 300_000, 300_000])
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => healDelayMs(n)), [20_000, 40_000, 90_000, 180_000, 300_000, 300_000, 300_000])
  assert.deepEqual(HEAL_DELAYS_MS, [20_000, 40_000, 90_000, 180_000, 300_000])
})

test('a successful repair finishes: nothing is rescheduled', async () => {
  const { clock, calls, healer } = setup(['retry', 'healed'])
  healer.start(CASHIER)
  await clock.advance(20_000 + 40_000)
  assert.equal(calls.length, 2)
  assert.equal(healer.isActive(), false)
  assert.equal(clock.pending(), 0)
  await clock.advance(60 * 60_000)
  assert.equal(calls.length, 2, 'no further attempts after healing')
})

test('"stop" (barcode no longer valid) ends it, and the same barcode is not retried for 30 minutes', async () => {
  const { clock, calls, healer } = setup(['stop'])
  healer.start(CASHIER)
  await clock.advance(20_000)
  assert.equal(healer.isActive(), false)
  assert.equal(healer.start(CASHIER), false, 'refused during the cooldown')
  assert.equal(healer.start({ cashierId: 'cashier-1', barcode: '81000002' }), true, 'a different barcode is a different target')
  healer.stop()
  await clock.advance(HEAL_STOP_COOLDOWN_MS)
  assert.equal(healer.start(CASHIER), true, 'allowed again once the cooldown has passed')
  assert.equal(calls.length, 1)
})

test('a cashier\'s own new sign-in ("force") overrides an earlier "stop"; the automatic restart does not', async () => {
  const { clock, calls, healer } = setup(['stop', 'healed'])
  healer.start(CASHIER)
  await clock.advance(20_000)
  assert.equal(healer.isActive(), false)
  assert.equal(healer.start(CASHIER, { immediate: true }), false, 'the automatic restart stays refused during the cooldown')
  assert.equal(healer.start(CASHIER, { force: true }), true, 'a deliberate sign-in is allowed straight away')
  await clock.advance(20_000)
  assert.equal(calls.length, 2)
  assert.equal(healer.isActive(), false, 'and it healed')
})

test('stopping while an attempt is on the network: its result is ignored and it must not install a session', async () => {
  let releaseAttempt
  let sawCurrent
  const { clock, calls, healer } = setup([
    (control) => new Promise((resolve) => { releaseAttempt = () => { sawCurrent = control.isCurrent(); resolve('retry') } }),
  ])
  healer.start(CASHIER)
  await clock.advance(20_000)
  assert.equal(calls.length, 1)
  healer.stop() // e.g. the cashier logged out
  releaseAttempt()
  await clock.advance(0)
  assert.equal(sawCurrent, false, 'the in-flight attempt is told it is no longer current')
  assert.equal(clock.pending(), 0, 'and nothing is rescheduled')
})

test('switching to another cashier mid-attempt: the old attempt cannot affect the new target', async () => {
  let release
  const { clock, calls, healer } = setup([
    () => new Promise((resolve) => { release = () => resolve('healed') }),
    'retry',
  ])
  healer.start(CASHIER)
  await clock.advance(20_000)
  healer.start({ cashierId: 'cashier-2', barcode: '81000009' })
  release() // the OLD attempt reports 'healed' -- it must not end the NEW target's repair
  await clock.advance(0)
  assert.equal(healer.isActive(), true)
  assert.equal(healer.current().cashierId, 'cashier-2')
  await clock.advance(20_000)
  assert.equal(calls.at(-1).cashierId, 'cashier-2')
})

test('starting the same target again keeps its schedule and attempt count (the sync loop calls this every minute)', async () => {
  const { clock, calls, healer } = setup([])
  healer.start(CASHIER)
  await clock.advance(20_000 + 40_000)
  assert.equal(calls.length, 2)
  assert.equal(healer.current().attempts, 2)
  assert.equal(healer.start(CASHIER), true)
  assert.equal(healer.current().attempts, 2, 'attempt count not reset')
  assert.equal(clock.pending(), 1, 'still exactly one timer')
})

test('an attempt that throws is treated as "retry", never crashes the loop', async () => {
  const { clock, calls, healer } = setup([() => { throw new Error('boom') }, 'healed'])
  healer.start(CASHIER)
  await clock.advance(20_000 + 40_000)
  assert.equal(calls.length, 2)
  assert.equal(healer.isActive(), false)
})

test('attempts never overlap: a slow attempt delays the next one instead of stacking', async () => {
  let release
  const { clock, calls, healer } = setup([() => new Promise((resolve) => { release = () => resolve('retry') })])
  healer.start(CASHIER)
  await clock.advance(20_000)
  await clock.advance(10 * 60_000) // plenty of time passes while attempt #1 is still waiting
  assert.equal(calls.length, 1, 'no second attempt while the first is unresolved')
  release()
  await clock.advance(0) // let the finished attempt schedule its retry
  assert.equal(calls.length, 1)
  await clock.advance(40_000)
  assert.equal(calls.length, 2)
})

test('missing cashier or barcode is refused', () => {
  const { healer } = setup([])
  assert.equal(healer.start({ cashierId: '', barcode: '81000001' }), false)
  assert.equal(healer.start({ cashierId: 'cashier-1', barcode: '  ' }), false)
  assert.equal(healer.start({}), false)
  assert.equal(healer.isActive(), false)
})
