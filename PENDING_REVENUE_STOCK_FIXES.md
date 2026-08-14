# Pending: Revenue/Stock-Critical Bug Fixes

Status as of 2026-08-15 (updated after the stock reconciler fix merged). Tracks the second half
of a two-part remediation triggered by the client repeatedly hitting PocketHost's API rate limit
(5-minute cooldown, sync blocked).

## Background

A full-codebase audit (three parallel review passes covering rate-limit request volume,
sale/payment/stock transaction paths, and sync/auth/infra) surfaced 40+ findings. Given this is
a live business's payment system, the work was scoped to two categories and everything else
(unguarded staff-management endpoints, UX-correctness bugs like double-tap double-ringing a
sale, error-message cleanup, dead code) was explicitly deferred to a future session:

1. **Rate limiting** — ✅ **DONE, merged to `main` at `f6eab1b`.**
2. **Revenue/stock-critical bugs** — 🔶 **IN PROGRESS.** 9 confirmed defects where a normal,
   expected sequence of events (a retry, two terminals, a busy day, a refund) causes the cloud
   to silently lose a sale, double-deduct or double-restock inventory, or misreport revenue.
   Stock reconciler rewrite (the biggest amplifier + a double-deduction bug) is done and merged
   to `main` at `5d3967e`. 6 tasks remain.

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

## Part 2 — Revenue/stock-critical bugs (IN PROGRESS)

Work-in-progress branch: `worktree-rate-limit-revenue-fixes` (exists locally at
`.claude/worktrees/rate-limit-revenue-fixes` and pushed to `origin`). SDD ledger and task briefs
already written at
`.claude/worktrees/rate-limit-revenue-fixes/.superpowers/sdd/the-client-has-a-golden-lobster/` —
resume from `progress.md` in that folder rather than re-deriving the plan from scratch.

### Done

- **Stock reconciler rewrite** (`src/utils/stockMovementReconciler.js`) — ✅ merged to `main` at
  `5d3967e`. Sorts by `created` (server autodate) not `created_at` (client timestamp); reads a
  bounded window (50 movements) instead of a product's entire history — the single biggest
  remaining request-volume amplifier; `findStockMovement` only treats a genuine 404 as "no
  movement yet," any other error (429, network blip) now fails loudly instead of being swallowed
  (`.catch(() => null)` was the direct cause of stock double-deduction on retry). Chain-mismatch
  detection between movements is a non-blocking diagnostic log only, not a gate — an earlier
  draft made it a hard gate (decline to reconcile on any mismatch), which was caught in review as
  a regression: it couldn't distinguish a genuine gap from two terminals legitimately writing
  concurrent movements off the same shared baseline (normal, frequent — the exact scenario this
  whole plan exists to protect), and would have left a racy, wrong stock value in place
  permanently instead of correcting it. The actual correction is always the mathematically
  correct delta-summed total. 114/114 offline tests passing.

### Remaining 6 tasks, in dependency order

1. **Admin sync engine parity** — port reachability caching (15s success / 8s failure TTL) and
   schedule jitter (±15s) into `admin-page/offline/syncEngine.js`; make the admin "Sync" click
   reuse a singleton `CashierSyncEngine` instead of constructing a new one per click; fix the
   manual-sync backoff wipe in both apps (never reset `attempts`, only clear `nextAttemptAt` for
   rows scheduled >60s out); fix cashier catalog-refresh backoff (currently resets
   `lastProductRefreshAt = 0` on every failure, retrying every tick forever). Deliberately
   skipped so far in favor of doing the stock reconciler first (bigger amplifier + a live
   correctness bug) — still needed, just deferred.

2. **Cashier sales-history N+1 + quick-login fan-out** — extract
   `groupSaleItemsBySaleId` into `src/utils/saleItemGrouping.js` (mirrors a fix already shipped
   on the admin side), replace the cashier history's one-request-per-sale fan-out; set
   `emailVisibility: true` at quick-login enable-time instead of a page-load backfill loop
   issuing one `users.update` per user.

3. **Sale-upload batch rewrite (B2+B3)** — replace `ensureCloudSaleItems` +
   `ensureCloudStockDeduction` (currently ~8 requests *per line item*) with one
   `uploadSaleCloudWrites()` using a single `pb.createBatch()` (transactional). Fixes stock
   double-deduction on retry (B2) and same-SKU-on-two-cart-lines under-deduction (B3) by giving
   each line item a stable `lineId` at `finalizeSaleLocally` time. Deletes the
   `Math.max(baseQuantityToDeduct, syncedQty)` fudge, which becomes actively wrong once keys are
   per-line. Same ordering fix needed in admin's scan/stock-out/adjust path and cashier's
   void/refund path.

4. **Refund/void correctness (B4, B5, B8, B9)** — refund restock must source unit `conversion`
   from the *stored* sale line, never caller-supplied data (B4); clamp refund amounts using
   `adjustLocalSale`'s authoritative result *before* queuing the cloud op, not raw UI input
   (B5/B8), in the same Dexie transaction (extract to
   `src/cashier-pos/offline/saleAdjustment.js`); add a void tombstone to close the race window
   where a void issued mid-upload leaves the cloud copy permanently "completed" (B9).

5. **Transaction number collisions (B1)** — new `src/cashier-pos/offline/transactionNumber.js`,
   all-numeric format `${YYYYMMDD}${6-digit terminal ordinal}${5-digit per-terminal daily
   counter}`, minted and verified inside `finalizeSaleLocally`'s Dexie transaction;
   `findExistingCloudSale` must require a corroborated match (cashier id + amount + timestamp),
   not just a string match. **Before landing: grep every `transactionNo` consumer (receipt
   layout, CSV export, legacy import) for length assumptions** — the new format is a different
   digit count than today's.

6. **Revenue/units reporting (B6)** — additive schema only (`sales.refunded_amount`,
   `sales.refunded_at`, new `sale_adjustments` collection with unique `adjustment_id` as the
   idempotency anchor); `total_amount` is never mutated, only reporting nets out. New
   `src/utils/saleTotals.js` pure helpers (`netSaleAmount`, `netSaleUnits`) wired into the admin
   dashboard/FSN builders and `cloud.js` report fetch. Legacy rows with no `refunded_amount`
   must return their full total/units unchanged.

## How to resume

Enter the existing worktree (`worktree-rate-limit-revenue-fixes` branch), read
`progress.md` in the SDD folder referenced above, and continue the task loop from the next
remaining task above — the original plan's Tasks 1, 2, and 4 (rate limiting ×2, stock
reconciler) are complete and already merged to `main` separately; Task 3 (admin sync engine
parity) was deliberately skipped over so far. Each new task's dispatch brief should be written
fresh against current `main` (rebase the worktree branch onto `origin/main` first and re-run
`npm run test:offline` to confirm a clean rebase before writing the brief), not assumed from the
old plan text verbatim — file line numbers shift as earlier tasks land.

## Out of scope for this whole effort (separate future session)

- Unguarded staff-management endpoints and other security gaps found in the same audit.
- UX-correctness bugs (e.g. double-tap double-ringing a sale).
- Error-message cleanup, dead code removal.
