# Pending: Revenue/Stock-Critical Bug Fixes

Status as of 2026-08-15. Tracks the second half of a two-part remediation triggered by the
client repeatedly hitting PocketHost's API rate limit (5-minute cooldown, sync blocked).

## Background

A full-codebase audit (three parallel review passes covering rate-limit request volume,
sale/payment/stock transaction paths, and sync/auth/infra) surfaced 40+ findings. Given this is
a live business's payment system, the work was scoped to two categories and everything else
(unguarded staff-management endpoints, UX-correctness bugs like double-tap double-ringing a
sale, error-message cleanup, dead code) was explicitly deferred to a future session:

1. **Rate limiting** — ✅ **DONE, merged to `main` at `f6eab1b`.**
2. **Revenue/stock-critical bugs** — ⏳ **NOT started.** 9 confirmed defects where a normal,
   expected sequence of events (a retry, two terminals, a busy day, a refund) causes the cloud
   to silently lose a sale, double-deduct or double-restock inventory, or misreport revenue.

Full plan detail (verified ground truth, exact code locations, rationale) lives in the original
plan file: `C:\Users\ASUS\.claude\plans\the-client-has-a-golden-lobster.md`. This doc is a
pointer + status summary, not a replacement for it.

## Locked-in decisions (do not re-litigate without the client)

- Transaction numbers stay **all-numeric** (BIR/bookkeeping safety).
- Refunds net out of **both revenue and units-sold/FSN analytics**, not revenue alone.
- Rate limiter is tuned for **1-2 terminals**, self-tuning from there (already shipped).

## Part 1 — Rate limiting (DONE)

Merged to `main` (`f6eab1b`, 2026-08-15): `src/utils/pocketbaseGovernor.js` (token bucket +
AIMD, escalating cooldown, priority lanes, keyed single-flight, cross-window persistence via
`localStorage`), `src/utils/pacedPocketBase.js` (wraps every `new PocketBase(...)` construction
site — all 10 in both apps), `src/utils/pocketbaseRateLimit.js` rewritten as a zero-behavior-
change facade. 103/103 offline tests passing.

## Part 2 — Revenue/stock-critical bugs (NOT started)

Work-in-progress branch: `worktree-rate-limit-revenue-fixes` (exists locally at
`.claude/worktrees/rate-limit-revenue-fixes` and pushed to `origin`). SDD ledger and task briefs
already written at
`.claude/worktrees/rate-limit-revenue-fixes/.superpowers/sdd/the-client-has-a-golden-lobster/` —
resume from `progress.md` in that folder rather than re-deriving the plan from scratch.

Remaining 7 tasks, in dependency order:

1. **Admin sync engine parity** — port reachability caching (15s success / 8s failure TTL) and
   schedule jitter (±15s) into `admin-page/offline/syncEngine.js`; make the admin "Sync" click
   reuse a singleton `CashierSyncEngine` instead of constructing a new one per click; fix the
   manual-sync backoff wipe in both apps (never reset `attempts`, only clear `nextAttemptAt` for
   rows scheduled >60s out); fix cashier catalog-refresh backoff (currently resets
   `lastProductRefreshAt = 0` on every failure, retrying every tick forever).

2. **Stock reconciler rewrite** (`src/utils/stockMovementReconciler.js`) — the single biggest
   remaining request-volume amplifier, plus a real correctness bug: sort by `created` (server
   autodate) not `created_at` (client timestamp); chain-validate movements instead of trusting a
   baseline (broken chain → return `null` and emit an anomaly, never guess); bound the read
   window instead of `getFullList`; stop swallowing probe errors (`.catch(() => null)` makes a
   429 indistinguishable from "no movement yet" — this silently causes double-deduction).

3. **Cashier sales-history N+1 + quick-login fan-out** — extract
   `groupSaleItemsBySaleId` into `src/utils/saleItemGrouping.js` (mirrors a fix already shipped
   on the admin side), replace the cashier history's one-request-per-sale fan-out; set
   `emailVisibility: true` at quick-login enable-time instead of a page-load backfill loop
   issuing one `users.update` per user.

4. **Sale-upload batch rewrite (B2+B3)** — replace `ensureCloudSaleItems` +
   `ensureCloudStockDeduction` (currently ~8 requests *per line item*) with one
   `uploadSaleCloudWrites()` using a single `pb.createBatch()` (transactional). Fixes stock
   double-deduction on retry (B2) and same-SKU-on-two-cart-lines under-deduction (B3) by giving
   each line item a stable `lineId` at `finalizeSaleLocally` time. Deletes the
   `Math.max(baseQuantityToDeduct, syncedQty)` fudge, which becomes actively wrong once keys are
   per-line. Same ordering fix needed in admin's scan/stock-out/adjust path and cashier's
   void/refund path.

5. **Refund/void correctness (B4, B5, B8, B9)** — refund restock must source unit `conversion`
   from the *stored* sale line, never caller-supplied data (B4); clamp refund amounts using
   `adjustLocalSale`'s authoritative result *before* queuing the cloud op, not raw UI input
   (B5/B8), in the same Dexie transaction (extract to
   `src/cashier-pos/offline/saleAdjustment.js`); add a void tombstone to close the race window
   where a void issued mid-upload leaves the cloud copy permanently "completed" (B9).

6. **Transaction number collisions (B1)** — new `src/cashier-pos/offline/transactionNumber.js`,
   all-numeric format `${YYYYMMDD}${6-digit terminal ordinal}${5-digit per-terminal daily
   counter}`, minted and verified inside `finalizeSaleLocally`'s Dexie transaction;
   `findExistingCloudSale` must require a corroborated match (cashier id + amount + timestamp),
   not just a string match. **Before landing: grep every `transactionNo` consumer (receipt
   layout, CSV export, legacy import) for length assumptions** — the new format is a different
   digit count than today's.

7. **Revenue/units reporting (B6)** — additive schema only (`sales.refunded_amount`,
   `sales.refunded_at`, new `sale_adjustments` collection with unique `adjustment_id` as the
   idempotency anchor); `total_amount` is never mutated, only reporting nets out. New
   `src/utils/saleTotals.js` pure helpers (`netSaleAmount`, `netSaleUnits`) wired into the admin
   dashboard/FSN builders and `cloud.js` report fetch. Legacy rows with no `refunded_amount`
   must return their full total/units unchanged.

## How to resume

Enter the existing worktree (`worktree-rate-limit-revenue-fixes` branch), read
`progress.md` in the SDD folder referenced above, and continue the task loop from Task 3
(admin sync engine parity) — Tasks 1-2 are complete and already merged to `main` separately, so
Task 3's dispatch brief should be written fresh against current `main`, not assumed from the old
plan text verbatim (re-verify file line numbers first, since Tasks 1-2's edits shifted some of
them).

## Out of scope for this whole effort (separate future session)

- Unguarded staff-management endpoints and other security gaps found in the same audit.
- UX-correctness bugs (e.g. double-tap double-ringing a sale).
- Error-message cleanup, dead code removal.
