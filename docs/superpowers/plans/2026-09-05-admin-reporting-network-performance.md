# Admin Reporting Network Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the admin dashboard and Transaction Logs page feeling much slower now that PocketBase runs on the client's self-hosted mini PC (reached via a Tailscale Funnel over the shop's own internet connection) instead of PocketHost's fast commercial hosting — without changing any numbers/behavior the client already relies on.

**Architecture:** Two independent, additive fixes to the Vercel-hosted admin's Express API (`server/index.js`) and the admin's Transaction Logs page (`src/admin-page/pages/TransactionLogs.jsx`). Both reduce the number/size of PocketBase round-trips per admin page load instead of trying to make the network path itself faster (which is a separate, non-code, operational concern — see "Out of scope").

**Tech Stack:** Node.js/Express (`server/index.js`), PocketBase JS SDK, React (admin-web), `node --test` (existing test convention in `tests/*.test.js`).

**Spec:** No separate spec document — derived directly from this session's live diagnosis (see "Context" below for the full investigation trail with exact file:line references).

## Context (why this is happening, and why it's not a simple "add code" bug)

This POS system was recently migrated from PocketHost (a commercial PocketBase host) to a mini PC the client bought and set up on-site, to fix a *different*, already-solved problem (PocketHost's rate-limit throttling at peak hours). The desktop cashier terminals now talk to the mini PC directly over the shop's own LAN — fast, and unaffected by anything in this plan.

The **Vercel-hosted admin portal** can't reach the mini PC's private LAN address directly (Vercel is a cloud service), so it was bridged via a **Tailscale Funnel** — a public HTTPS URL that tunnels back to the mini PC over the shop's own internet connection. That connection has nowhere near PocketHost's bandwidth/latency characteristics. Two admin-only code paths were already inefficient before the migration, but PocketHost's fast infrastructure absorbed the cost invisibly. Over the new, much slower path, the same inefficiencies are now clearly felt by the client:

1. **`GET /api/receipts`** (`server/index.js:1238-1280`) — powers the admin's **Transaction Logs** page (`src/admin-page/pages/TransactionLogs.jsx`) and **Cashier Sales Report** (`src/admin-page/pages/CashierSalesReport.jsx`, via `api.receipts(...)`). It fetches the `sales` collection, then for **every single sale** makes a **separate** PocketBase request for that sale's `sale_items` (`receiptRecordFromSale`, `server/index.js:354-360`). A store with, say, 2,000 sales in the requested range means **2,001 separate round trips** to PocketBase for one page load — a classic N+1 query pattern.

2. **`TransactionLogs.jsx` always fetches the full, unbounded sales history** regardless of what date range is selected in its own UI. `useApi(api.receipts, [])` (`TransactionLogs.jsx:108`) calls `api.receipts()` with **no arguments** — so `/api/receipts`'s optional date filter (`dateFilterParts`, `server/index.js:1249-1251`) never engages by default. The page's `dateRange` dropdown (defaulting to `'all'`, `TransactionLogs.jsx:114`) only filters the *already-downloaded* data client-side (`filteredReceipts`, `TransactionLogs.jsx:203-234`) — it never triggers a new, narrower server request. So opening Transaction Logs always downloads the **entire** sales history via the N+1 path above, no matter what the user picks afterward.

`CashierSalesReport.jsx` (`:79-84`) already does this correctly today — it always passes explicit `fromDate`/`toDate` to `api.receipts(...)`, so it already gets PocketBase-side date filtering. It still pays the N+1 cost per sale within its range, so it benefits from Task 1 below too.

**`GET /api/dashboard`** (`server/index.js:2038-2224`, powers Dashboard and, via `CashierSalesReport`'s sibling page, Analytics) was investigated too. It currently downloads the *entire* `sales`/`sale_items`/`sale_adjustments` history on every load and filters in memory (`server/index.js:2051-2055`) — looks like the same bug at first glance. **It is not safely fixable the same way**: the same handler also computes an **8-month trend** and a **5-year yearly trend** (`server/index.js:2159-2162`, `monthlyTrend = lastMonths(8, now)`, `yearlyTrend = lastYears(5, now)`). Bounding the query to, say, "last month" (which would be safe for the daily/monthly comparison stats) would silently zero out most of both trend charts — a real regression, not a fix. A correct fix for this endpoint requires either a careful, fully-audited field-projection pass (shrinking bytes-per-record without shrinking the row count) or a bigger architectural change (pre-aggregated daily/monthly rollup records instead of scanning raw sales every time). Both are real, valuable follow-ups but are **deliberately out of scope for this plan** — see "Out of scope" at the bottom. Do not attempt to bound `/api/dashboard`'s query range as part of this plan; it would break the yearly/monthly trend charts.

## Global Constraints

- No change to any number, total, or chart the client currently sees — this is a pure performance fix, not a behavior change, except for the one explicit UX decision in Task 2 (Transaction Logs' default date range).
- This codebase's convention for PocketBase batched lookups is the OR-joined filter pattern already established in `src/utils/stockMovementReconciler.js`'s `findExistingStockMovementsByReference` (see its own comment there for why: a single query beats N separate ones, and — like here — a genuine network/request failure must still propagate to the caller rather than being swallowed as "not found").
- This repo's test convention is `node --test` files under `tests/`, testing pure/exported helper functions directly (e.g. `tests/dashboard-refund-netting.test.js` imports `buildSalesMetrics`/`refundedUnitsBySaneAndProduct` straight from `server/index.js`) or spinning up the real Express app and hitting it with `fetch` (`tests/admin-vercel-boundary.test.js`). There are zero React component tests anywhere in this repo (`tests/*.test.jsx` — none exist) — UI-only changes (Task 2) are verified manually via `npm run build` + a live check, matching how every other UI change in this project has been verified.
- Run `npm run test:offline` and `npm run test:vercel` after every task — both must stay fully green (baseline: 352/352 and 7/7 respectively, confirmed earlier this session).

---

### Task 1: Batch the N+1 `sale_items` fetch in `/api/receipts`

**Files:**
- Modify: `server/index.js:354-406` (`receiptRecordFromSale`), `server/index.js:1238-1280` (`/api/receipts` route), `server/index.js:2381-2395` (export list)
- Test: `tests/receipts-sale-items-grouping.test.js` (new)

**Interfaces:**
- Produces: `groupSaleItemsBySaleId(items)` — a new exported pure function, `(sale_items[]) => Map<saleId, sale_items[]>`. Used only inside `/api/receipts` for now, but exported for direct unit testing (matching `refundedUnitsBySaleAndProduct`'s existing pattern in the same file).
- Modifies: `receiptRecordFromSale(sale, items)` — second parameter changes from a PocketBase collection object to a plain, already-filtered array of that sale's `sale_items` records. No longer needs to be `async` (nothing left to `await` once the fetch is removed), but stays compatible with its existing `Promise.all(sales.map(...))` caller either way.

- [ ] **Step 1: Write the failing test for `groupSaleItemsBySaleId`**

Create `tests/receipts-sale-items-grouping.test.js`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.VERCEL = '1'
process.env.AUTO_BACKUP_ENABLED = 'false'

const { groupSaleItemsBySaleId } = await import('../server/index.js')

test('groupSaleItemsBySaleId groups items under their sale_id', () => {
  const items = [
    { id: 'i1', sale_id: 'sale1', quantity_sold: 2 },
    { id: 'i2', sale_id: 'sale1', quantity_sold: 1 },
    { id: 'i3', sale_id: 'sale2', quantity_sold: 5 },
  ]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.size, 2)
  assert.deepEqual(grouped.get('sale1').map((item) => item.id), ['i1', 'i2'])
  assert.deepEqual(grouped.get('sale2').map((item) => item.id), ['i3'])
})

test('groupSaleItemsBySaleId handles a relation field expanded as a one-element array', () => {
  // PocketBase relation fields sometimes arrive as [id] instead of a bare
  // id string depending on the query -- productRelationId/dashboardSaleSource
  // elsewhere in server/index.js already handle this same shape.
  const items = [{ id: 'i1', sale_id: ['sale1'], quantity_sold: 2 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.deepEqual(grouped.get('sale1').map((item) => item.id), ['i1'])
})

test('groupSaleItemsBySaleId skips items with no sale_id rather than throwing', () => {
  const items = [{ id: 'i1', sale_id: '', quantity_sold: 2 }, { id: 'i2', sale_id: null, quantity_sold: 1 }]
  const grouped = groupSaleItemsBySaleId(items)
  assert.equal(grouped.size, 0)
})

test('groupSaleItemsBySaleId returns an empty map for an empty input', () => {
  assert.equal(groupSaleItemsBySaleId([]).size, 0)
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test tests/receipts-sale-items-grouping.test.js`
Expected: FAIL — `groupSaleItemsBySaleId` is not exported yet (`SyntaxError` or `undefined is not a function`).

- [ ] **Step 3: Add `groupSaleItemsBySaleId` and export it**

In `server/index.js`, add this function near `refundedUnitsBySaleAndProduct` (both are small pure grouping helpers over PocketBase relation records, so keeping them adjacent matches the file's existing organization):

```js
// Groups sale_items records by their sale_id, handling the same
// one-element-array relation shape productRelationId/dashboardSaleSource
// already handle elsewhere in this file. Used to replace one PocketBase
// request per sale with a single batched fetch -- see /api/receipts, whose
// previous one-request-per-sale loop turned a fast query on PocketHost into
// thousands of round trips once PocketBase moved behind a much slower
// self-hosted/Tailscale-Funnel network path.
function groupSaleItemsBySaleId(items) {
  const grouped = new Map()
  for (const item of items) {
    const saleId = Array.isArray(item.sale_id) ? item.sale_id[0] : item.sale_id
    if (!saleId) continue
    if (!grouped.has(saleId)) grouped.set(saleId, [])
    grouped.get(saleId).push(item)
  }
  return grouped
}
```

Add `groupSaleItemsBySaleId` to the existing `export { ... }` block at `server/index.js:2381-2395` (alphabetically, between `dateKey` and `lastDays`).

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test tests/receipts-sale-items-grouping.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/index.js tests/receipts-sale-items-grouping.test.js
git commit -m "$(cat <<'EOF'
feat(admin): add groupSaleItemsBySaleId helper for batched receipt lookups

Prep step for eliminating /api/receipts' per-sale N+1 query -- this pure
grouping function is unit-tested on its own before the route is rewired
to use it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Rewrite `receiptRecordFromSale` to accept pre-fetched items instead of querying per-sale**

In `server/index.js`, change the function signature and body (currently `server/index.js:354-360`):

```js
// BEFORE
async function receiptRecordFromSale(sale, saleItemsCollection) {
  const cashier = saleCashier(sale)
  const items = await saleItemsCollection.getFullList({
    sort: 'created',
    filter: pb.filter('sale_id = {:saleId}', { saleId: sale.id }),
    expand: 'product_id',
  })
```

to:

```js
// AFTER
function receiptRecordFromSale(sale, items) {
  const cashier = saleCashier(sale)
```

(Nothing else in the function body changes — every line after the removed fetch already only reads from the local `items` variable, so this is a pure signature change. Confirmed by reading the full function body: `server/index.js:361-406`.)

- [ ] **Step 7: Rewrite the `/api/receipts` route to batch-fetch `sale_items` once**

Replace the current body (`server/index.js:1253-1260`):

```js
// BEFORE
const sales = await (await pbCollection('sales')).getFullList({
  sort: '-created_at,-created',
  expand: 'cashier_id',
  perPage: 500,
  ...(dateFilterParts.length ? { filter: dateFilterParts.join(' && ') } : {}),
})
const saleItems = await pbCollection('sale_items')
const records = await Promise.all(sales.map((sale) => receiptRecordFromSale(sale, saleItems)))
```

with:

```js
// AFTER
const sales = await (await pbCollection('sales')).getFullList({
  sort: '-created_at,-created',
  expand: 'cashier_id',
  perPage: 500,
  ...(dateFilterParts.length ? { filter: dateFilterParts.join(' && ') } : {}),
})

// One batched request for every sale's line items instead of one request
// PER sale (see groupSaleItemsBySaleId's own comment for why this matters
// now that PocketBase lives behind a much slower network path).
const itemsBySaleId = sales.length
  ? groupSaleItemsBySaleId(
      await (await pbCollection('sale_items')).getFullList({
        sort: 'created',
        filter: sales.map((sale) => pb.filter('sale_id = {:saleId}', { saleId: sale.id })).join(' || '),
        expand: 'product_id',
      }),
    )
  : new Map()

const records = sales.map((sale) => receiptRecordFromSale(sale, itemsBySaleId.get(sale.id) || []))
```

- [ ] **Step 8: Run the full offline + Vercel test suites**

Run: `npm run test:offline` — expect 352/352 (unchanged; this route has no dedicated existing test, but nothing else should regress).
Run: `npm run test:vercel` — expect 7/7 (unchanged).
Run: `npm run build:vercel` — expect a clean build.

- [ ] **Step 9: Manual verification against the live mini PC**

This route can't be fully exercised by the existing test suite without a live PocketBase (there is no fake-`pb` harness for `server/index.js`'s module-level `pb`/`pbCollection`, unlike the offline sync engine tests). Verify directly:
1. Open the deployed admin (`https://pos-system-taupe-eight.vercel.app`), go to **Transaction Logs**.
2. Confirm receipts still load with the correct items/quantities/prices per transaction (compare a couple of known transactions against what the mini PC's own PocketBase dashboard shows for the same sale's `sale_items`).
3. Time the page load before/after (browser dev tools Network tab, or just a stopwatch) to confirm it's meaningfully faster than before this task.

- [ ] **Step 10: Commit**

```bash
git add server/index.js
git commit -m "$(cat <<'EOF'
fix(admin): eliminate /api/receipts' N+1 sale_items query

Replaces one PocketBase request per sale with a single batched OR-filter
request (same pattern as findExistingStockMovementsByReference), grouped
in memory via groupSaleItemsBySaleId. This is the main reason Transaction
Logs and the Cashier Sales Report felt dramatically slower after moving
PocketBase off PocketHost onto the client's self-hosted mini PC -- the
per-sale round trips were always there, PocketHost's infrastructure just
absorbed the cost invisibly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Make Transaction Logs actually use its own date filter server-side

**Files:**
- Modify: `src/admin-page/pages/TransactionLogs.jsx:107-116` (state + data fetch)

**Interfaces:**
- Consumes: `api.receipts(filters)` (existing, `src/admin-page/services/api.js:154-162` — already accepts `{ fromDate, toDate, ... }` and omits empty values from the query string, unchanged by this task).
- Consumes: `filterDates(range, customFrom, customTo)` (existing local function, `TransactionLogs.jsx:50-56`, unchanged).

- [ ] **Step 1: Move the date-range state above the data fetch, and change the default**

In `src/admin-page/pages/TransactionLogs.jsx`, the component currently declares (lines 107-116):

```js
export default function TransactionLogs() {
  const { data: receipts, setData: setReceipts, loading, error } = useApi(api.receipts, [])
  const { data: cashiers } = useApi(api.cashiers, [])
  const { data: catalogProducts } = useApi(api.products, [])
  const { data: catalogCategories } = useApi(api.categories, [])
  const scanInputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
```

Change it to:

```js
export default function TransactionLogs() {
  const { data: cashiers } = useApi(api.cashiers, [])
  const { data: catalogProducts } = useApi(api.products, [])
  const { data: catalogCategories } = useApi(api.categories, [])
  const scanInputRef = useRef(null)
  const [query, setQuery] = useState('')
  // Defaults to the last 30 days instead of the full history: opening this
  // page previously always downloaded every sale ever made (see this
  // session's plan doc) regardless of what a user picked in this dropdown
  // afterward, because the fetch below never used to depend on these three
  // values. "All" is still one click away in the dropdown for a genuine
  // full-history export -- it's just no longer the default cost of simply
  // opening the page.
  const [dateRange, setDateRange] = useState('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const loadReceipts = useCallback(() => {
    const { fromDate, toDate } = filterDates(dateRange, customFrom, customTo)
    return api.receipts({ fromDate, toDate })
  }, [dateRange, customFrom, customTo])
  const { data: receipts, setData: setReceipts, loading, error } = useApi(loadReceipts, [])
```

(`filterDates` is already declared above the component, at module scope, so it's reachable here unchanged. `useCallback` is already imported at the top of the file, line 1.)

- [ ] **Step 2: Confirm the existing client-side date filter still behaves correctly**

No code change needed here — just verify by reading: `filteredReceipts` (`TransactionLogs.jsx:203-234`) already re-derives its own `fromDate`/`toDate` from the same `dateRange`/`customFrom`/`customTo` values and re-filters whatever `receipts` currently holds. Since `receipts` will now already be scoped to the selected range server-side, this client-side filter becomes a harmless no-op narrowing (filtering data that's already within range) rather than the primary date filter — it's what makes switching, say, from "Last 30 Days" to "Today" feel instant (no network wait) while the wider fetch is still in flight or already cached from the initial load. Leave this block completely untouched.

- [ ] **Step 3: Build and manually verify**

Run: `npm run build:vercel` — expect a clean build (this is a JSX-only change; no new npm dependency, `useCallback` already imported).

Manual check against the live deployment:
1. Open Transaction Logs. Confirm it now defaults to showing **"Date: month"** as an active filter chip (or however the UI surfaces the current `dateRange`) and loads noticeably faster than before Task 1 + this task.
2. Switch the date dropdown to **"All"** — confirm it re-fetches (a brief loading state) and then shows full history correctly.
3. Switch to **"Today"** — confirm it narrows correctly.
4. Confirm **Cashier Sales Report** (which already passed its own date range before this change) still works identically — this task doesn't touch it.

- [ ] **Step 4: Commit**

```bash
git add src/admin-page/pages/TransactionLogs.jsx
git commit -m "$(cat <<'EOF'
fix(admin): scope Transaction Logs' initial load to the last 30 days

Previously the page always fetched the store's ENTIRE sales history on
open (useApi(api.receipts, []) called with no arguments, so /api/receipts'
own optional date filter never engaged), and the date-range dropdown only
ever narrowed the already-downloaded data client-side. Combined with the
N+1 fix in the prior commit, this was the dominant cost of opening this
page. The dropdown's own re-fetch now actually reaches the server;
"All" is still explicitly selectable for a full-history view.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification (after both tasks)

1. `npm run test:offline` — 352/352.
2. `npm run test:vercel` — 7/7.
3. `npm run build:vercel` — clean.
4. Live check on the deployed admin: Transaction Logs and Cashier Sales Report both load faster and show correct data; a spot-checked transaction's items/quantities/prices match the mini PC's own PocketBase dashboard.
5. Redeploy the Vercel project (env vars are unaffected by this plan — no new env vars needed) and re-run the live check against the redeployed instance.

## Out of scope (deliberately, not silently dropped)

- **`/api/dashboard` (Dashboard + Analytics)** still downloads full sales/sale_items/sale_adjustments history on every load. As explained in "Context," it cannot be safely date-bounded the way `/api/receipts` was, because the same handler computes an 8-month and a 5-year trend chart from that same data. A real fix here is one of:
  - A careful, fully field-by-field-audited PocketBase `fields=` projection to cut bytes-per-record (not row count) — every field `/api/dashboard` and its helpers (`saleCashier`, `toProduct`, `dashboardSaleSource`, etc.) actually read across the whole ~180-line handler would need to be enumerated first; getting this wrong silently breaks a stat rather than just being slow, so it deserves its own dedicated pass rather than being folded in here.
  - Or a bigger architectural change: pre-aggregated daily/monthly rollup records maintained incrementally (e.g. updated whenever a sale completes/voids/refunds) instead of re-scanning raw sales on every dashboard load. This would also make the 5-year yearly trend cheap regardless of how much history accumulates, which raw-record scanning never will be.
- **Tailscale network path itself.** This plan only reduces how much data/how many requests cross the slow path — it doesn't investigate whether Tailscale is relaying through a DERP server vs. a direct connection (`tailscale ping <mini-pc-tailscale-ip>` on the mini PC would show this), which independently affects the latency of every request regardless of these fixes. Worth checking as a separate, non-code, operational step if the admin still feels slow after this plan lands.
- **The cashier desktop terminals' own "Recent Transactions" modal** (`src/cashier-pos/pages/Cashier.jsx`) is unaffected by anything in this plan — it talks to the mini PC directly over the shop's LAN, not through Vercel/Tailscale. Its own known slowness (unbounded local+cloud fetch) is tracked separately in `C:\Users\ASUS\.claude\plans\run-another-audit-check-golden-wave.md` and is a different problem with a different fix.
