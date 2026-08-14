# PocketHost Rate-Limit Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the number of PocketBase HTTP requests each cashier terminal makes during a normal business day so a multi-terminal store no longer trips PocketHost's 429 rate limit, without weakening the existing 429 handling/backoff that already exists as the last line of defense.

**Architecture:** No new subsystems. Three surgical changes to the existing offline-first cashier sync stack (`src/cashier-pos/offline/syncEngine.js`, `src/cashier-pos/offline/cloudBootstrap.js`): (1) cache the cloud-reachability probe the same way `src/admin-page/services/desktopApi.js` already does, eliminating a redundant `pb.health.check()` call on almost every sync cycle; (2) stagger each terminal's periodic sync tick with a fixed per-instance jitter so N terminals don't all call PocketHost in the same second; (3) widen the two existing polling floors now that the redundant health check is gone. A fourth task wires the existing (currently unused) throttle regression test, plus the new tests this plan adds, into the `test:offline` CI script so this class of regression stays covered.

**Tech Stack:** Vanilla JS (ES modules), PocketBase JS SDK, Dexie (IndexedDB) for local cache, `node:test` + `fake-indexeddb` for tests — matching the existing patterns in `tests/sync-rate-limit-backoff.test.js` and `tests/cashier-scan-catalog-refresh-throttle.test.js`.

**Spec:** No standalone spec document. This plan is derived from a live debugging conversation about a cashier terminal that was silently unable to scan products; that investigation surfaced `src/utils/pocketbaseRateLimit.js`'s 5-minute post-429 lockout and the request patterns below as the underlying pressure that trips it. Problem statement:

- Each cashier terminal runs `CashierSyncEngine` (`src/cashier-pos/offline/syncEngine.js`), which on every sync cycle (every 60s via its timer, **and** immediately after every completed sale via `desktopApi.js:1041`'s `void activeRuntime.syncEngine.syncNow()`) calls `isCloudReachable()`, which calls `pb.health.check()` — a full network round trip — with **no caching**, every single time there is queued work or a catalog refresh due.
- Separately, scanning an item not yet in the local cache, or the periodic background refresh, calls `refreshLocalProductCatalog()` (`src/cashier-pos/offline/cloudBootstrap.js`), floored at once per 60 seconds (`BACKGROUND_REFRESH_MIN_INTERVAL_MS`); `CashierSyncEngine` separately floors its own catalog refresh at once per 2 minutes (`PRODUCT_REFRESH_INTERVAL_MS`).
- During a busy period, a single terminal can therefore make on the order of 2 PocketBase requests (health check + upload) per completed sale, plus periodic catalog-refresh requests, and none of this is staggered across terminals — a store with several terminals selling concurrently can burst well above PocketHost's per-account rate limit.
- `src/admin-page/services/desktopApi.js` already solved the exact same problem for the admin dashboard: its `isCloudReachable()` (line 74) caches a successful check for 15s and a failed check for 8s (`reachabilityCache`, lines 39, 78, 90, 94), so its ~30 call sites collapse to roughly one real `health.check()` request per cache window. `CashierSyncEngine.isCloudReachable()` has no equivalent cache — this plan ports that proven pattern over.

## Global Constraints

- Do not change the existing 429-handling/backoff behavior in `src/utils/pocketbaseRateLimit.js` or the per-operation exponential backoff in `syncEngine.js` (`retryDelay`, `MAX_BACKOFF_MS`, `MAX_ATTEMPTS`) — this plan is about *avoiding* 429s, not changing what happens after one.
- Do not change `forceNetworkCheck: true` semantics: an explicit forced check (used by the manual "Sync" button and by `admin-page`'s cross-store recovery path) must always bypass caches and throttles and hit the network.
- All new/changed constants must remain named, top-of-file, single source of truth (no magic numbers inline) — matches existing style in both touched files.
- All new tests follow the existing house style: `node:test` + `assert/strict`, `fake-indexeddb/auto` imported first, a hand-rolled `fakePb` object (no mocking library), `{ concurrency: false }` on tests that share the module-level rate-limit/throttle state, and explicit `resetPocketBaseRateLimit()` / `resetProductCatalogRefreshThrottle()` cleanup at the start of each test.

---

## Task 1: Cache cashier cloud-reachability checks

**Files:**
- Modify: `src/cashier-pos/offline/syncEngine.js:16-19` (constants), `211-268` (`CashierSyncEngine` constructor + `isCloudReachable`)
- Test: `tests/cashier-sync-reachability-cache.test.js` (create)

**Interfaces:**
- Consumes: nothing new — `CashierSyncEngine` already imports `isPocketBaseRateLimited`, `rememberPocketBaseRateLimit` from `../../utils/pocketbaseRateLimit`.
- Produces: `CashierSyncEngine.isCloudReachable({ forceNetworkCheck })` keeps its existing signature and return type (`Promise<boolean>`); no other task depends on new exports from this task.

- [ ] **Step 1: Write the failing test**

Create `tests/cashier-sync-reachability-cache.test.js`:

```javascript
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// Every sync cycle (every 60s, and again immediately after each completed
// sale) called isCloudReachable(), which hit pb.health.check() with no
// caching. Across several terminals ringing up sales back-to-back, that
// redundant round trip roughly doubled PocketHost request volume for no
// reason: admin-page/services/desktopApi.js already solved this with a
// short-lived reachability cache. This ports that pattern to the cashier.

function fakePb(healthCalls) {
  return {
    autoCancellation() {},
    health: {
      async check() {
        healthCalls.count += 1
      },
    },
  }
}

test('consecutive isCloudReachable calls within the cache window only hit health.check once', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

  const first = await engine.isCloudReachable()
  const second = await engine.isCloudReachable()
  const third = await engine.isCloudReachable()

  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(third, true)
  assert.equal(healthCalls.count, 1, 'a burst of reachability checks must only hit the network once')

  await cashierDb.delete()
})

test('forceNetworkCheck bypasses the reachability cache', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb(healthCalls) })

  await engine.isCloudReachable()
  await engine.isCloudReachable({ forceNetworkCheck: true })

  assert.equal(healthCalls.count, 2, 'an explicit forced check must always hit the network')

  await cashierDb.delete()
})

test('a cached failure is also reused instead of hammering health.check while down', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const healthCalls = { count: 0 }
  const pb = {
    autoCancellation() {},
    health: {
      async check() {
        healthCalls.count += 1
        const err = new Error('fetch failed')
        throw err
      },
    },
  }
  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb })

  const first = await engine.isCloudReachable()
  const second = await engine.isCloudReachable()

  assert.equal(first, false)
  assert.equal(second, false)
  assert.equal(healthCalls.count, 1, 'a burst of checks while offline must only probe the network once')

  resetPocketBaseRateLimit()
  await cashierDb.delete()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-sync-reachability-cache.test.js`
Expected: FAIL — `healthCalls.count` is `3` (and `2`) instead of `1`, because `isCloudReachable()` has no cache yet.

- [ ] **Step 3: Add the reachability cache to `CashierSyncEngine`**

In `src/cashier-pos/offline/syncEngine.js`, add two constants near the existing `DEFAULT_INTERVAL_MS` block (after line 19):

```javascript
const DEFAULT_INTERVAL_MS = 60_000
const PRODUCT_REFRESH_INTERVAL_MS = 2 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_ATTEMPTS = 10
// Mirrors admin-page/services/desktopApi.js's reachabilityCache: a plain
// health.check() on every sync cycle (every 60s, and again immediately
// after each completed sale) roughly doubled PocketHost request volume for
// no benefit — a positive check 15s ago is still true 15s later.
const REACHABILITY_SUCCESS_TTL_MS = 15_000
const REACHABILITY_FAILURE_TTL_MS = 8_000
```

In the constructor (currently lines 216-229), add the cache field after `this.lastProductRefreshAt = 0`:

```javascript
    this.lastProductRefreshAt = 0
    this.reachabilityCache = { value: false, expiresAt: 0 }
```

Replace `isCloudReachable` (currently lines 257-268):

```javascript
  async isCloudReachable({ forceNetworkCheck = false } = {}) {
    if (!forceNetworkCheck && globalThis.navigator && !globalThis.navigator.onLine) return false
    if (!forceNetworkCheck && isPocketBaseRateLimited()) return false
    if (!forceNetworkCheck && Date.now() < this.reachabilityCache.expiresAt) return this.reachabilityCache.value

    try {
      await this.pb.health.check({ requestKey: null })
      this.reachabilityCache = { value: true, expiresAt: Date.now() + REACHABILITY_SUCCESS_TTL_MS }
      return true
    } catch (error) {
      rememberPocketBaseRateLimit(error)
      this.reachabilityCache = { value: false, expiresAt: Date.now() + REACHABILITY_FAILURE_TTL_MS }
      return false
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-sync-reachability-cache.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the full offline suite to check for regressions**

Run: `npm run test:offline`
Expected: PASS — in particular `sync-rate-limit-backoff.test.js`'s two tests, which call `runSync({ forceNetworkCheck: true })` and must be unaffected since that flag bypasses the new cache.

- [ ] **Step 6: Commit**

```bash
git add src/cashier-pos/offline/syncEngine.js tests/cashier-sync-reachability-cache.test.js
git commit -m "Cache cashier cloud-reachability checks to cut redundant PocketHost requests"
```

---

## Task 2: Stagger each terminal's periodic sync tick

**Files:**
- Modify: `src/cashier-pos/offline/syncEngine.js:16-19` (constant), `211-255` (constructor + `schedule`)
- Test: `tests/cashier-sync-schedule-jitter.test.js` (create)

**Interfaces:**
- Consumes: `CashierSyncEngine` constructor/instance fields from Task 1 (`this.reachabilityCache` unaffected by this task).
- Produces: `CashierSyncEngine.jitterMs` (a `number`, fixed for the instance's lifetime, in `[0, SCHEDULE_JITTER_MS)`), read by `schedule()`. No later task depends on this.

- [ ] **Step 1: Write the failing test**

Create `tests/cashier-sync-schedule-jitter.test.js`:

```javascript
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { CashierSyncEngine } from '../src/cashier-pos/offline/syncEngine.js'
import { resetPocketBaseRateLimit } from '../src/utils/pocketbaseRateLimit.js'

// A store running several cashier terminals all started CashierSyncEngine
// on the same 60s cadence with no offset between them, so their periodic
// sync ticks tended to land in the same second and burst PocketHost at
// once. Each terminal now carries a small fixed jitter added to its
// steady-state interval so ticks spread out across the store instead of
// stacking.

function fakePb() {
  return { autoCancellation() {}, health: { async check() {} } }
}

function withStubbedTimeout(run) {
  const original = globalThis.setTimeout
  const calls = []
  globalThis.setTimeout = (fn, delay) => {
    calls.push(delay)
    return original(() => {}, 0) // never actually fire during the test
  }
  try {
    run(calls)
  } finally {
    globalThis.setTimeout = original
  }
}

test('jitterMs is stable per instance and within the documented range', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb() })

  assert.ok(Number.isInteger(engine.jitterMs))
  assert.ok(engine.jitterMs >= 0 && engine.jitterMs < 15_000)
  assert.equal(engine.jitterMs, engine.jitterMs, 'jitter must not be re-rolled between reads')

  await cashierDb.delete()
})

test('the steady-state schedule() call adds this instance\'s jitter to the base interval', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetPocketBaseRateLimit()

  const engine = new CashierSyncEngine({ baseUrl: 'http://127.0.0.1:8090', pb: fakePb() })
  engine.stopped = false

  withStubbedTimeout((calls) => {
    engine.schedule()
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 60_000 + engine.jitterMs)
  })

  withStubbedTimeout((calls) => {
    engine.schedule(0)
    assert.equal(calls[0], 0, 'an explicit immediate reschedule (startup, coming back online) must not be jittered')
  })

  if (engine.timer) clearTimeout(engine.timer)
  await cashierDb.delete()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-sync-schedule-jitter.test.js`
Expected: FAIL — `engine.jitterMs` is `undefined`, and `schedule()`'s captured delay is `60000`, not `60000 + jitterMs`.

- [ ] **Step 3: Add the jitter**

In `src/cashier-pos/offline/syncEngine.js`, add the constant next to the other schedule-related ones:

```javascript
const REACHABILITY_SUCCESS_TTL_MS = 15_000
const REACHABILITY_FAILURE_TTL_MS = 8_000
// Spreads each terminal's steady-state 60s tick across up to 15s so a store
// running several terminals doesn't have them all call PocketHost in the
// same second. Fixed once per engine instance, not re-rolled per tick.
const SCHEDULE_JITTER_MS = 15_000
```

In the constructor, add after `this.reachabilityCache = { value: false, expiresAt: 0 }`:

```javascript
    this.jitterMs = Math.floor(Math.random() * SCHEDULE_JITTER_MS)
```

Replace `schedule` (currently lines 250-255):

```javascript
  schedule(delay = this.intervalMs + this.jitterMs) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const rateLimitDelay = pocketBaseRateLimitRemainingMs()
    this.timer = setTimeout(() => void this.syncNow(), Math.max(delay, rateLimitDelay))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-sync-schedule-jitter.test.js`
Expected: PASS (both tests)

- [ ] **Step 5: Run the full offline suite to check for regressions**

Run: `npm run test:offline`
Expected: PASS — `start()` and `handleOnline()` both call `this.schedule(0)`, an explicit delay, so they remain un-jittered and existing timing-sensitive tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/cashier-pos/offline/syncEngine.js tests/cashier-sync-schedule-jitter.test.js
git commit -m "Stagger cashier terminals' periodic sync tick to avoid request bursts"
```

---

## Task 3: Widen the catalog-refresh polling floors

**Files:**
- Modify: `src/cashier-pos/offline/cloudBootstrap.js:9` (`BACKGROUND_REFRESH_MIN_INTERVAL_MS`)
- Modify: `src/cashier-pos/offline/syncEngine.js:17` (`PRODUCT_REFRESH_INTERVAL_MS`)
- Test: `tests/cashier-catalog-refresh-floors.test.js` (create)

**Interfaces:**
- Consumes: `refreshLocalProductCatalog`, `resetProductCatalogRefreshThrottle` from `cloudBootstrap.js` (existing exports, unchanged signatures).
- Produces: nothing new consumed by later tasks — this task only changes constant values and adds a regression test pinning them.

- [ ] **Step 1: Write the failing test**

Create `tests/cashier-catalog-refresh-floors.test.js`:

```javascript
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { refreshLocalProductCatalog, resetProductCatalogRefreshThrottle } from '../src/cashier-pos/offline/cloudBootstrap.js'

// Task 1 removed a redundant health.check() from most sync cycles, which
// buys headroom to also widen the two existing polling floors (background
// scan-triggered refresh, and the sync engine's own periodic catalog
// refresh) so a busy store makes noticeably fewer catalog-refresh requests
// per hour without the catalog going meaningfully staler.

function fakePb(listCalls) {
  return {
    autoCancellation() {},
    collection(name) {
      if (name === 'products') {
        return { async getFullList() { listCalls.count += 1; return [] } }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
    files: { getURL: () => '' },
  }
}

test('background refresh floor is at least 3 minutes', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  resetProductCatalogRefreshThrottle()

  const listCalls = { count: 0 }
  const pb = fakePb(listCalls)
  const baseUrl = 'http://127.0.0.1:8090'

  await refreshLocalProductCatalog({ baseUrl, pb, background: true })

  const realNow = Date.now
  Date.now = () => realNow() + 2 * 60_000 + 30_000 // 2m30s later — inside the old 60s floor's "long expired" range, but must still be throttled under the new floor
  try {
    await refreshLocalProductCatalog({ baseUrl, pb, background: true })
  } finally {
    Date.now = realNow
  }

  assert.equal(listCalls.count, 1, 'a background refresh 2m30s after the last one must still be throttled under a >=3min floor')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-catalog-refresh-floors.test.js`
Expected: FAIL — `listCalls.count` is `2`, because the current 60s floor lets a refresh 2m30s later through.

- [ ] **Step 3: Widen the floors**

In `src/cashier-pos/offline/cloudBootstrap.js`, change line 9:

```javascript
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 3 * 60_000
```

(keep the existing comment above it as-is — it still accurately describes why the floor exists, only the value changes)

In `src/cashier-pos/offline/syncEngine.js`, change line 17:

```javascript
const PRODUCT_REFRESH_INTERVAL_MS = 5 * 60_000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./tests/helpers/register-loader.mjs --test tests/cashier-catalog-refresh-floors.test.js`
Expected: PASS

- [ ] **Step 5: Run the full offline suite to check for regressions**

Run: `npm run test:offline`
Expected: PASS — `cashier-scan-catalog-refresh-throttle.test.js` (once wired in by Task 4) only asserts relative ordering ("throttled" vs "not throttled"), not the exact floor value, so it stays green under the new constant.

- [ ] **Step 6: Commit**

```bash
git add src/cashier-pos/offline/cloudBootstrap.js src/cashier-pos/offline/syncEngine.js tests/cashier-catalog-refresh-floors.test.js
git commit -m "Widen cashier catalog-refresh floors now that redundant health checks are gone"
```

---

## Task 4: Wire the rate-limit regression tests into CI

**Files:**
- Modify: `package.json:28` (`test:offline` script)

**Interfaces:**
- Consumes: the test files created in Tasks 1-3, plus the pre-existing `tests/cashier-scan-catalog-refresh-throttle.test.js` (confirmed present on disk but not currently listed in `test:offline`, so it does not run in CI today).
- Produces: nothing consumed by other tasks — this is the last task.

- [ ] **Step 1: Confirm the gap**

Run: `npm run test:offline -- 2>&1 | grep -c catalog-refresh-throttle` (or just re-read `package.json:28`)
Expected: the throttle test file's name does not appear — it is not part of the script's file list, so `npm run test:offline` currently never runs it.

- [ ] **Step 2: Add all four rate-limit-related test files to the script**

In `package.json`, replace the `test:offline` line (line 28):

```json
    "test:offline": "node --import ./tests/helpers/register-loader.mjs --test tests/cashier-activity-log-sync.test.js tests/cashier-catalog-refresh-floors.test.js tests/cashier-scan-catalog-refresh-throttle.test.js tests/cashier-sync-reachability-cache.test.js tests/cashier-sync-schedule-jitter.test.js tests/offline-product-catalog.test.js tests/offline-restart-persistence.test.js tests/offline-two-terminal-sync.test.js tests/out-of-stock-sale.test.js tests/product-delete-sync.test.js tests/return-disposition.test.js tests/stock-availability.test.js tests/stock-conversion.test.js tests/stock-movement-drift.test.js tests/quantity.test.js tests/sync-rate-limit-backoff.test.js tests/transaction-log-sort.test.js",
```

- [ ] **Step 3: Run the full script to verify everything passes together**

Run: `npm run test:offline`
Expected: PASS — all listed files, including the previously-orphaned throttle test and the three new ones from Tasks 1-3, run and pass in one process.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Run all cashier rate-limit regression tests as part of test:offline"
```

---

## Self-Review Notes

- **Coverage:** the problem statement's three levers (redundant health checks, unstaggered ticks, tight polling floors) each map to a task (1, 2, 3); the "tests exist but don't run" gap found during investigation maps to Task 4.
- **Type/signature consistency:** `isCloudReachable({ forceNetworkCheck })` keeps its existing shape; `schedule(delay)` keeps its existing shape (only the default value expression changes); no function names changed across tasks.
- **Out of scope, deliberately:** switching the cashier catalog to realtime PocketBase subscriptions (`pb.collection('products').subscribe(...)`) would cut request volume further, but that pattern exists only as dead code in `admin-page/services/cloud.js` (`subscribeToProducts`, never called) — it is unproven in this app under real store networking conditions (WebView2, LAN drops, PocketHost's SSE limits on lower tiers) and is a materially bigger, riskier change than the four tasks above. Worth a follow-up plan once Tasks 1-4 are in production and there's data on whether they were sufficient.
