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
      () => rawSend(path, opts).then(
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
