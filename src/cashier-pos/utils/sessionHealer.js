// Repairs a cashier session that signed in without a usable cloud login.
//
// When a barcode login could not be verified by any server, the terminal lets
// the cashier work (sales are queued safely on the terminal) but has no cloud
// session, so nothing uploads. Before this, that state lasted until somebody
// typed an email and password -- in one real case five hours and 53 sales. The
// healer instead keeps trying, quietly, to verify the barcode the cashier
// already used, and the moment a server answers it installs the session and the
// queued sales upload on their own.
//
// This module is only the scheduling/bookkeeping, with every side effect
// injected, so it can be tested without a browser, timers or a network:
//   attempt(target, { isCurrent }) -> 'healed' | 'stop' | 'retry'
//     'healed'  the session is now valid -- finished.
//     'stop'    give up on this target (barcode no longer valid, a different
//               cashier is signed in, ...). It is not retried for a while.
//     'retry'   still cannot verify -- try again after a growing delay.
//   isCurrent() turns false as soon as the healer is stopped or re-targeted,
//   so an attempt that was already on the network can tell it must NOT install
//   its session (e.g. the cashier logged out while it was waiting for a reply).

export const HEAL_DELAYS_MS = [20_000, 40_000, 90_000, 180_000, 300_000]
export const HEAL_STOP_COOLDOWN_MS = 30 * 60_000

export function healDelayMs(attempt, delays = HEAL_DELAYS_MS) {
  const index = Math.min(Math.max(0, Math.floor(Number(attempt) || 0)), delays.length - 1)
  return delays[index]
}

export function createSessionHealer({
  attempt,
  schedule,
  cancel,
  now = () => Date.now(),
  delays = HEAL_DELAYS_MS,
  stopCooldownMs = HEAL_STOP_COOLDOWN_MS,
}) {
  let current = null // { cashierId, barcode, attempts, timer }
  let generation = 0
  const suppressedUntil = new Map() // `${cashierId}:${barcode}` -> timestamp

  const targetKey = (target) => `${target.cashierId}:${target.barcode}`

  function clearTimer() {
    if (current && current.timer !== null && current.timer !== undefined) {
      cancel(current.timer)
      current.timer = null
    }
  }

  function stop() {
    clearTimer()
    current = null
    generation += 1
  }

  async function run(myGeneration) {
    const target = current
    if (!target || myGeneration !== generation) return
    target.timer = null

    let outcome
    try {
      outcome = await attempt(
        { cashierId: target.cashierId, barcode: target.barcode },
        { isCurrent: () => myGeneration === generation },
      )
    } catch {
      outcome = 'retry'
    }

    // Stopped or re-targeted while the attempt was in flight: it is not ours to continue.
    if (myGeneration !== generation) return

    if (outcome === 'healed') {
      current = null
      generation += 1
      return
    }
    if (outcome === 'stop') {
      suppressedUntil.set(targetKey(target), now() + stopCooldownMs)
      current = null
      generation += 1
      return
    }

    target.attempts += 1
    target.timer = schedule(() => { void run(myGeneration) }, healDelayMs(target.attempts, delays))
  }

  // Returns true when this cashier is (now) being repaired, false when it was
  // refused (bad input, or recently told to stop for this exact barcode).
  // `force` is for a cashier's own deliberate sign-in: that is new information
  // (the account may have been reactivated, the server may be back), so it
  // overrides an earlier "stop". The cooldown exists only to keep the AUTOMATIC
  // once-a-minute restart from hammering a barcode the server has refused.
  function start({ cashierId, barcode }, { immediate = false, force = false } = {}) {
    const id = String(cashierId || '').trim()
    const code = String(barcode || '').trim()
    if (!id || !code) return false

    const next = { cashierId: id, barcode: code, attempts: 0, timer: null }
    if (current && targetKey(current) === targetKey(next)) return true // already on it; keep its schedule

    if (force) suppressedUntil.delete(targetKey(next))
    const blockedUntil = suppressedUntil.get(targetKey(next)) || 0
    if (blockedUntil > now()) return false

    stop()
    current = next
    const myGeneration = generation
    current.timer = schedule(() => { void run(myGeneration) }, immediate ? 0 : healDelayMs(0, delays))
    return true
  }

  return {
    start,
    stop,
    isActive: () => current !== null,
    current: () => (current ? { cashierId: current.cashierId, barcode: current.barcode, attempts: current.attempts } : null),
  }
}
