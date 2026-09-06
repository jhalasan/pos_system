# Dashboard/Analytics Network Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `/api/dashboard` (powers Dashboard and Analytics) downloading the store's entire sales/sale_items/sale_adjustments history on every load, now that PocketBase runs behind the slow Tailscale Funnel path instead of PocketHost — without changing any number/chart the client already sees.

**Architecture:** Push the date range PocketBase-side (as a query filter) instead of downloading everything and filtering with a JS `.filter()` afterward. Follow-up to `docs/superpowers/plans/2026-09-05-admin-reporting-network-performance.md`, which fixed the same class of bug in `/api/receipts` but explicitly left `/api/dashboard` out of scope pending this investigation.

**Tech Stack:** Node.js/Express (`server/index.js`), PocketBase JS SDK, `node --test`.

**Spec:** No separate spec document — derived from this session's live investigation (see "Context").

## Context

The prior plan (`2026-09-05-admin-reporting-network-performance.md`) ruled out bounding `/api/dashboard`'s query by date, reasoning that its 8-month and 5-year trend charts (`server/index.js:2159-2162`, `lastMonths(8, now)` / `lastYears(5, now)`) need long history regardless of the requested date range. **That reasoning was wrong** — re-reading the trend-population loop (`server/index.js:2167-2180`) shows the trend arrays are filled purely from `completedSales`, which is itself already filtered by the request's own `source`/`from`/`to` (`server/index.js:2051-2055`) before the trend loop ever runs. The trend charts have never independently reached further back than whatever date range the caller already asked for — the *chart bucket shapes* span 5 years/8 months, but only get non-zero data within whatever the already-applied `from`/`to` covers. So the fix that was safe for `/api/receipts` is safe here too, and simpler than first thought: push the existing date filter into the PocketBase query instead of computing it after downloading everything.

This matters immediately because Dashboard's own UI (`src/admin-page/pages/Dashboard.jsx:25`) **defaults to `range = '30'`** (last 30 days), not "all time" — so the overwhelmingly common case (opening the Dashboard with its default filter) already only *needs* ~30 days of data, but the server currently downloads the client's entire lifetime history to compute it every single time.

One filter genuinely can't be pushed into PocketBase: `dashboardSaleSource(sale)` (`server/index.js:2056-2061`) classifies a sale as `sample`/`legacy`/`live` by pattern-matching its `transaction_no`/`id` — it's a computed classification, not a stored field, so PocketBase can't filter on it server-side. The `source` filter stays exactly as it is today (an in-memory `.filter()`), applied *after* the date-bounded fetch. This plan only changes how the date bound is applied, not the source bound.

**`sale_items`/`sale_adjustments` are date-scoped via their parent sale's ID, not their own timestamp field** — same batching approach already proven correct in the sibling `/api/receipts` fix (`groupSaleItemsBySaleId`), rather than assuming those collections have their own reliable `created_at` field. Fetch `sales` bounded by date first, then batch-fetch `sale_items`/`sale_adjustments` via one OR-joined `sale_id` filter over the resulting sale IDs (same technique, applied here to two collections instead of one).

## Global Constraints

- No change to any number, stat, or chart the client currently sees — this is a pure performance fix. Verify by comparing the JSON response body before/after this change for the same request (same `from`/`to`/`source`), not just eyeballing the UI.
- Reuses the OR-joined-filter batching pattern already established in `src/utils/stockMovementReconciler.js`'s `findExistingStockMovementsByReference` and this session's own `groupSaleItemsBySaleId` (`server/index.js`).
- Run `npm run test:offline` and `npm run test:vercel` after the change — both must stay fully green (baseline at the start of this plan: 356/356 and 7/7).

---

### Task 1: Push `/api/dashboard`'s date filter into the PocketBase query

**Files:**
- Modify: `server/index.js:2063-2070` (`/api/dashboard` route, the three history fetches)
- Test: `tests/dashboard-date-scoping.test.js` (new)

**Interfaces:**
- Reuses: `groupSaleItemsBySaleId` (already exported from `server/index.js`, added in the prior plan) — generalized here to also group `sale_adjustments` by `sale_id` (it already handles the one-element-array relation shape either collection could produce).

- [ ] **Step 1: Write the failing test for the new date-filter-building helper**

This route builds its PocketBase filter string inline today (no extracted helper) — extract the exact same filter-building expression `/api/receipts` already uses (`server/index.js:1262-1264`) into a small shared, exported, testable function first, since duplicating an inline filter-string expression across two routes without a shared function is exactly the kind of thing that silently drifts out of sync later.

Create `tests/dashboard-date-scoping.test.js`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { buildCreatedAtRangeFilter } = await import('../server/index.js')

test('buildCreatedAtRangeFilter with both bounds includes both clauses', () => {
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-31T23:59:59.999Z'))
  assert.match(filter, /created_at >= "2026-08-01/)
  assert.match(filter, /created_at <= "2026-08-31/)
  assert.match(filter, /&&/)
})

test('buildCreatedAtRangeFilter with only a from bound omits the to clause', () => {
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), null)
  assert.match(filter, /created_at >= "2026-08-01/)
  assert.equal(filter.includes('&&'), false)
})

test('buildCreatedAtRangeFilter with neither bound returns an empty string', () => {
  assert.equal(buildCreatedAtRangeFilter(null, null), '')
})

test('buildCreatedAtRangeFilter tolerates a legacy row with no created_at at all', () => {
  // Matches the existing /api/receipts precedent (server/index.js:1263-1264):
  // a sale with no created_at should still match rather than being silently
  // excluded, since created_at was backfilled later in this project's history.
  const filter = buildCreatedAtRangeFilter(new Date('2026-08-01T00:00:00.000Z'), null)
  assert.match(filter, /created_at = ""/)
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test tests/dashboard-date-scoping.test.js`
Expected: FAIL — `buildCreatedAtRangeFilter` is not exported yet.

- [ ] **Step 3: Extract `buildCreatedAtRangeFilter` and use it in both `/api/receipts` and `/api/dashboard`**

In `server/index.js`, add this function near `groupSaleItemsBySaleId` (both are small helpers the date-filtered reporting routes share):

```js
// Builds a PocketBase filter expression bounding a collection's created_at
// field to [from, to] (either end optional). A record with no created_at at
// all still matches -- created_at was backfilled onto this project's sales
// collection after some rows already existed, so treating "missing" as "no
// bound applies to this legacy row" avoids silently excluding it, matching
// the precedent already established in the /api/receipts route this was
// extracted from.
function buildCreatedAtRangeFilter(from, to) {
  const parts = []
  if (from) parts.push(pb.filter('(created_at >= {:from} || created_at = "")', { from: from.toISOString() }))
  if (to) parts.push(pb.filter('(created_at <= {:to} || created_at = "")', { to: to.toISOString() }))
  return parts.join(' && ')
}
```

Add `buildCreatedAtRangeFilter` to the `export { ... }` block (alphabetically, between `buildSalesMetrics` and `dateKey`).

Then simplify `/api/receipts`'s existing inline version (`server/index.js:1259-1264`) to call it:

```js
// BEFORE
const fromTime = phDateStringToUtcMillis(fromDate, false)
const toTime = phDateStringToUtcMillis(toDate, true)

const dateFilterParts = []
if (fromTime !== null) dateFilterParts.push(pb.filter('(created_at >= {:from} || created_at = "")', { from: new Date(fromTime).toISOString() }))
if (toTime !== null) dateFilterParts.push(pb.filter('(created_at <= {:to} || created_at = "")', { to: new Date(toTime).toISOString() }))

const sales = await (await pbCollection('sales')).getFullList({
  sort: '-created_at,-created',
  expand: 'cashier_id',
  perPage: 500,
  ...(dateFilterParts.length ? { filter: dateFilterParts.join(' && ') } : {}),
})
```

```js
// AFTER
const fromTime = phDateStringToUtcMillis(fromDate, false)
const toTime = phDateStringToUtcMillis(toDate, true)
const receiptsDateFilter = buildCreatedAtRangeFilter(
  fromTime === null ? null : new Date(fromTime),
  toTime === null ? null : new Date(toTime),
)

const sales = await (await pbCollection('sales')).getFullList({
  sort: '-created_at,-created',
  expand: 'cashier_id',
  perPage: 500,
  ...(receiptsDateFilter ? { filter: receiptsDateFilter } : {}),
})
```

(Purely a refactor — same two `phDateStringToUtcMillis` calls, same resulting filter string, now built by the shared function instead of duplicated inline.)

- [ ] **Step 4: Run the new test to confirm it passes, and the full offline suite to confirm the `/api/receipts` refactor didn't change behavior**

Run: `node --test tests/dashboard-date-scoping.test.js` — expect PASS, all 4 cases.
Run: `npm run test:offline` — expect 356/356 (unchanged).
Run: `npm run test:vercel` — expect 7/7 (unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/index.js tests/dashboard-date-scoping.test.js
git commit -m "$(cat <<'EOF'
refactor(admin): extract buildCreatedAtRangeFilter from /api/receipts

Pulls the inline date-filter-building expression into a small, tested,
shared function so /api/dashboard's upcoming date-scoping fix (next
commit) reuses the exact same, already-correct logic instead of a second
copy that could silently drift out of sync with it later.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Rewrite `/api/dashboard`'s three history fetches to use the date filter, and batch sale_items/sale_adjustments by sale ID**

Replace (`server/index.js:2063-2070`, using the line numbers as they stood before Step 3's edits shifted them slightly — locate by content, not exact line number, since Step 3 already touched this file):

```js
// BEFORE
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const products = (await listRecords('products', '?expand=category&perPage=500')).map(toProduct)
  let sales = await listRecords('sales', '?perPage=500')
  let saleItems = await listRecords('sale_items', '?expand=product_id&perPage=500')
  // sale_adjustments may not exist on an un-migrated PocketBase instance
  // (M1's schema migration is additive and applied separately) -- fall back
  // to no netting rather than failing the whole dashboard.
  let adjustments = await listRecords('sale_adjustments', '?perPage=500').catch(() => [])
  const source = String(req.query.source || 'all')
  const fromMillis = phDateStringToUtcMillis(req.query.from, false)
  const toMillis = phDateStringToUtcMillis(req.query.to, true)
  const from = fromMillis === null ? null : new Date(fromMillis)
  const to = toMillis === null ? null : new Date(toMillis)
  sales = sales.filter((sale) => (source === 'all' || dashboardSaleSource(sale) === source)
    && (!from || saleDate(sale) >= from) && (!to || saleDate(sale) <= to))
  const filteredSaleIds = new Set(sales.map((sale) => sale.id))
  saleItems = saleItems.filter((item) => filteredSaleIds.has(Array.isArray(item.sale_id) ? item.sale_id[0] : item.sale_id))
  adjustments = adjustments.filter((adjustment) => filteredSaleIds.has(productRelationId(adjustment.sale_id)))
```

with:

```js
// AFTER
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const products = (await listRecords('products', '?expand=category&perPage=500')).map(toProduct)
  const source = String(req.query.source || 'all')
  const fromMillis = phDateStringToUtcMillis(req.query.from, false)
  const toMillis = phDateStringToUtcMillis(req.query.to, true)
  const from = fromMillis === null ? null : new Date(fromMillis)
  const to = toMillis === null ? null : new Date(toMillis)
  const dashboardDateFilter = buildCreatedAtRangeFilter(from, to)

  // Pushed down to the PocketBase query instead of downloading the store's
  // entire lifetime history and discarding most of it in memory -- see this
  // session's plan doc. dashboardSaleSource can't be expressed as a
  // PocketBase filter (it pattern-matches transaction_no/id to classify
  // sample/legacy/live rows), so the source filter below stays exactly as
  // it was: applied in memory, after the date-bounded fetch.
  let sales = (await (await pbCollection('sales')).getFullList(
    dashboardDateFilter ? { filter: dashboardDateFilter } : {},
  )).filter((sale) => source === 'all' || dashboardSaleSource(sale) === source)

  const filteredSaleIds = new Set(sales.map((sale) => sale.id))
  const saleIdFilter = sales.length
    ? sales.map((sale) => pb.filter('sale_id = {:saleId}', { saleId: sale.id })).join(' || ')
    : ''

  let saleItems = saleIdFilter
    ? await (await pbCollection('sale_items')).getFullList({ expand: 'product_id', filter: saleIdFilter })
    : []
  // sale_adjustments may not exist on an un-migrated PocketBase instance
  // (M1's schema migration is additive and applied separately) -- fall back
  // to no netting rather than failing the whole dashboard.
  let adjustments = saleIdFilter
    ? await (await pbCollection('sale_adjustments')).getFullList({ filter: saleIdFilter }).catch(() => [])
    : []
```

(The two `.filter()` calls narrowing `saleItems`/`adjustments` to `filteredSaleIds` that used to follow this block are now redundant — the batched fetch already only returns items/adjustments belonging to `sales` in `filteredSaleIds`, since that's exactly what `saleIdFilter` was built from. Delete those two now-dead lines, which immediately followed the block above:)

```js
// DELETE these two lines (now redundant, superseded by the batched fetch above)
saleItems = saleItems.filter((item) => filteredSaleIds.has(Array.isArray(item.sale_id) ? item.sale_id[0] : item.sale_id))
adjustments = adjustments.filter((adjustment) => filteredSaleIds.has(productRelationId(adjustment.sale_id)))
```

Everything else in the handler (`server/index.js`, from the `const now = new Date()` line onward) is unchanged — it only ever reads from the now-already-correctly-scoped `sales`/`saleItems`/`adjustments`/`filteredSaleIds` local variables, which still hold exactly the same *values* as before, just computed via a query filter instead of a full download + JS filter.

- [ ] **Step 7: Run the full test suite and build**

Run: `npm run test:offline` — expect 356/356.
Run: `npm run test:vercel` — expect 7/7.
Run: `npm run build:vercel` — expect a clean build.
Run: `npm run lint` — expect the same 0-error baseline.

- [ ] **Step 8: Manual verification against the live mini PC — confirm byte-for-byte identical output, not just "looks right"**

This route has no dedicated existing automated test against live data (same situation as `/api/receipts` in the prior plan — no fake-`pb` harness exists for this module's `pb`/`pbCollection`). Verify directly, comparing the actual response body before and after:

1. Before deploying, note today's Dashboard numbers on the *currently deployed* (unfixed) version for a specific, reproducible filter — e.g. open the deployed admin, set the date range to a specific recent week, and record `stats.totalRevenue`, `stats.transactionCount`, `topProducts`, and the `monthlySales`/`yearlySales` trend arrays (screenshot or copy the values).
2. Deploy this change.
3. Reload Dashboard with the **exact same date range and source filter** and confirm every one of those values is identical.
4. Confirm the page loads faster than before.
5. Repeat for **Analytics** (same underlying route) and for the **"All Time"** range specifically, since that's the one case where this fetch is still intentionally unbounded (same as before this change) — confirm it still returns correct all-time totals.

- [ ] **Step 9: Commit**

```bash
git add server/index.js
git commit -m "$(cat <<'EOF'
fix(admin): scope /api/dashboard's PocketBase queries to the requested date range

Was downloading the store's entire sales/sale_items/sale_adjustments
history on every single Dashboard/Analytics load and filtering by date in
memory afterward -- Dashboard's own UI already defaults to a 30-day range,
so the common case was paying for a full-history download it immediately
discarded most of. The prior plan (see the sibling doc) initially ruled
this route out, reasoning its 8-month/5-year trend charts needed long
history regardless of the requested range -- re-reading the trend
population loop shows they're filled from the same already-date-filtered
sales list as everything else, so this is safe: same computed output,
same charts, just fetched via a PocketBase query filter instead of a full
download. sale_items/sale_adjustments are now batch-fetched by sale_id
(same pattern as the /api/receipts fix) rather than downloaded in full and
filtered afterward.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification (after the task)

1. `npm run test:offline` — 356/356.
2. `npm run test:vercel` — 7/7.
3. `npm run build:vercel` — clean.
4. `npm run lint` — same 0-error baseline.
5. Live check per Step 8 above: identical output, faster load, for both a bounded range and "All Time".
6. Push to `origin/main`, confirm Vercel auto-deploys, re-verify on the live deployment.

## Out of scope (deliberately, not silently dropped)

- **Field-level payload trimming** (e.g. PocketBase `fields=` projections to drop unused expanded product data from `sale_items`) is a separate, smaller optimization layered on top of this one. Worth doing eventually, not required for the main win here.
- **The Tailscale network path itself** (relayed vs. direct connection) — same note as the sibling plan: worth checking with `tailscale ping` on the mini PC as a separate, non-code, operational step if things still feel slow after this lands.
