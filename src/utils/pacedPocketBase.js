// Wraps an already-constructed PocketBase client so every request it makes
// (everything funnels through `pb.send` internally, regardless of which
// `.collection(...)` helper triggered it) flows through a shared
// `pocketbaseGovernor` instance for pacing, priority lanes, and 429
// bookkeeping.
//
// This module deliberately does NOT retry anything. The existing
// per-operation Dexie backoff (syncEngine.js) already owns durable retry —
// a silent retry here would double-execute writes and break the idempotency
// assumptions later tasks in this plan depend on. On error, the only job
// here is to feed `governor.recordRateLimit()` and re-throw unchanged.

const HEALTH_PATH = '/api/health'

// Neither the PocketBase SDK nor any caller in this app sets a request
// timeout -- a stalled/degraded connection to PocketHost (slow response,
// half-open TCP connection) leaves the awaiting code hanging indefinitely,
// with no error and no recovery. Confirmed live: a cashier scanning a
// barcode not yet in the local catalog, or clicking the manual Sync button,
// both directly await a network call with nothing to bound how long they
// wait -- this is what surfaces to a cashier as "the system hangs."
// Racing every request against this timeout (rather than passing an
// AbortSignal into the SDK's own options) is deliberate: the SDK builds its
// own internal AbortController and overwrites `options.signal` whenever
// auto-cancellation is active (i.e. whenever a call does NOT pass
// `requestKey: null`), which would silently make an externally-supplied
// signal a no-op for most calls in this codebase. A promise race works
// regardless of the SDK's internal signal handling.
const REQUEST_TIMEOUT_MS = 20_000

function withTimeout(promise, path) {
  let timeoutId
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Request to PocketHost timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${path}).`)
      error.isTimeout = true
      reject(error)
    }, REQUEST_TIMEOUT_MS)
  })
  // If the timeout wins, the underlying request is still running in the
  // background (this SDK gives no reliable way to actually abort it once
  // auto-cancellation's own controller owns the signal). Attach a silent
  // catch so its eventual settlement doesn't surface as an unhandled
  // promise rejection nobody is listening for anymore.
  promise.catch(() => {})
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

/**
 * Pure classification of a request's pacing priority from its path/options.
 * Exported standalone so it's independently testable without a real (or
 * fake) PocketBase client.
 *
 * - `/api/health` → 'background' (a reachability probe, never worth
 *   pacing ahead of real work).
 * - Any other GET → 'interactive'. PocketBase's own SDK does not expose a
 *   path shape that reliably distinguishes a "background" full-list fetch
 *   from any other GET (getFullList just pages the same
 *   /api/collections/:name/records endpoint as getList/getOne) — rather
 *   than over-engineer path-sniffing, call sites that want background
 *   pacing for a specific GET opt in explicitly via `$priority`.
 * - POST/PATCH/PUT/DELETE (including PocketBase's /api/batch endpoint,
 *   which is itself a POST) → 'write'.
 * - Anything unclassified → 'interactive', failing toward not blocking the
 *   request, per Task 1's design philosophy for that lane.
 */
export function classifyRequest(path, options = {}) {
  const normalizedPath = String(path || '')
  if (normalizedPath.startsWith(HEALTH_PATH)) return 'background'

  const method = String(options.method || 'GET').toUpperCase()
  if (method === 'GET') return 'interactive'
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') return 'write'

  return 'interactive'
}

/**
 * Mutates `pb` in place, replacing `pb.send` with a paced version, and
 * returns the same instance for convenient chaining at construction sites
 * (`const pb = createPacedPocketBase(new PocketBase(baseUrl), governor)`).
 *
 * Intentionally does NOT touch any `.collection(...)` call site — every
 * collection helper method in the PocketBase SDK ultimately calls
 * `this.client.send(...)`, so wrapping `send` alone is sufficient to pace
 * everything the client does.
 */
export function createPacedPocketBase(pb, governor) {
  const rawSend = pb.send.bind(pb)

  pb.send = (path, options = {}) => {
    const priority = options.$priority || classifyRequest(path, options)
    const opts = { ...options }
    // PocketBase forwards any option key it doesn't recognize as a query
    // param (see normalizeUnknownQueryParams in the SDK) — `$priority`
    // must never reach `rawSend`, or it leaks into the actual HTTP request.
    delete opts.$priority

    return governor.schedule(
      () => withTimeout(rawSend(path, opts), path).then(
        (result) => {
          governor.recordSuccess()
          return result
        },
        (error) => {
          if (Number(error?.status) === 429) governor.recordRateLimit(error)
          throw error
        },
      ),
      { priority, label: path },
    )
  }

  return pb
}
