# Cashier Shift Ledger Reconciliation — Design

## Context

A live client report: a 2nd-shift cashier's hand-tallied transactions for August 25 summed to
₱2,773, but the terminal's own shift-close report showed only ₱1,347. The underlying `sales`
records in PocketBase were confirmed complete and correct for that shift (via direct query) — the
discrepancy was never in what actually got sold, only in what the terminal *reported* selling.

Investigation traced this to `Cashier.jsx`'s `completedCashSales`/`completedGcashSales` — the
figures printed on the shift-close Z-read and written to the durable cash-audit log
(`closeShift`, `Cashier.jsx:1358`). These are computed from `retainedCompletedSales`, a JSON blob
kept in raw `localStorage` (`src/cashier-pos/utils/cashSales.js`), with two real defects:

1. **`saveRetainedCompletedSales`'s `localStorage.setItem` call has no error handling.** If it
   throws for any reason (quota exceeded, private-mode restriction, a WebView2 hiccup), the
   exception propagates up through `completeActiveTransaction` — by which point the sale has
   *already* been recorded successfully in the cloud. The sale is real; the cash is real; the
   local tally of it silently is not.
2. **`loadRetainedCompletedSales`'s parse failure silently returns `[]`.** Any corruption of that
   `localStorage` entry (e.g., a write interrupted by a crash or power loss — not rare on
   lower-end POS hardware) resets the entire shift's running sales total to empty, with no
   warning, log, or recovery path.

Either failure produces exactly the reported symptom: a terminal-reported total lower than
reality, while the drawer's actual cash is correct (since every sale genuinely happened and the
cash is genuinely there) — surfacing as an unexplained "excess" rather than a real shortage.

Compounding this, `confirmResumeCash` (`Cashier.jsx:1165-1235`, the post-restart/resume cash-count
check) treats any mismatch between the physical drawer count and the software's `expectedShiftCash`
as a cash-handling event and silently books a compensating Cash In/Out adjustment — papering over a
software data-loss bug as if it were a real-world cash-counting mistake, so the drawer still
"balances" at close while the wrong number gets permanently baked into the audit trail.

**Design constraint (explicit, from the client-facing stakes of this fix): this must never cause a
sale to go uncounted, and must never block a cashier from completing a sale or closing a shift.**
Anything that could fail closed is worse than the bug it replaces.

## What already exists that solves half of this

This app already has a proper, durable, transactional local database for exactly this data:
`cashierDb.completedSales` (Dexie/IndexedDB, `src/cashier-pos/offline/db.js`). Every sale is
written into it atomically, in the same Dexie transaction that decrements stock and queues the
sale for cloud sync (`saleRepository.js:170-177`), and it is correctly updated in place when a sale
is later voided (`saleRepository.js:283-292`) or partially refunded/exchanged
(`saleRepository.js:446-453`). Its row shape (`paymentMethod`, `totalAmount`, `cashAmount`,
`gcashAmount`, `splitPayments`, `adjustments`) is already exactly what `cashSales.js`'s
`getCashSalesAmount`/`getGcashSalesAmount` expect — those functions do not need to change at all,
only what they're pointed at.

`retainedCompletedSales` was never a necessary cache — it was a second, more fragile copy of data
that was already being durably persisted elsewhere in the same codebase, one transaction earlier
and more reliably.

## Approach

Two options were considered:

- **B (rejected): Dexie as a safety net only.** Keep today's in-memory `transactions`-array
  accumulation for the live running display during a normal uninterrupted shift, and only pull
  from Dexie at shift-resume and shift-close as an authoritative override.
- **A (chosen): Dexie as the single, continuous source of truth.** `completedCashSales`/
  `completedGcashSales` are recomputed from `cashierDb.completedSales` every time a sale
  completes, voids, or gets refunded — for both the live display and the final shift-close number.
  One code path, one source of truth, always.

Option B still leaves two parallel representations of the same number that can drift from each
other, in a smaller way — which is the same structural mistake being removed. Option A means there
is exactly one number, computed the same way, everywhere, all the time. Dexie queries here are
cheap (`cashierId` is already an indexed field; a shift's sale count tops out in the low hundreds),
so there is no meaningful performance cost.

## Changes

### New: `getShiftLedgerTotals(cashierId, sinceISO)` in `src/cashier-pos/offline/saleRepository.js`

Queries `cashierDb.completedSales.where('cashierId').equals(cashierId)`, filters to
`createdAt >= sinceISO`, and returns `{ cashSales, gcashSales }` by passing the resulting rows
straight into the existing `getCashSalesAmount`/`getGcashSalesAmount` from `cashSales.js`. Pure
composition — no new netting logic. `sinceISO` will always be `shiftSession.openedAt`, which is
stable across a resume (resuming reloads the same persisted session object; it does not create a
new one), so a plain time-window filter correctly scopes "this shift's sales" without needing a new
`sessionId` field on the Dexie row.

### `Cashier.jsx`: `completedCashSales`/`completedGcashSales` become async-loaded state

Replace the current synchronous `useMemo` (fed by `retainedCompletedSales` + `transactions`) with
`useState` + a `useEffect` that calls `getShiftLedgerTotals(user.id, shiftSession.openedAt)`,
keyed on the same dependency the old memo already used (`[transactions, shiftSession, user?.id]`)
— `transactions` already changes at every point a sale completes, voids, or is refunded, so no new
trigger-tracking is needed.

On query failure, **keep the last-known value** rather than resetting to 0 or an empty state, and
surface a visible notification. A silent reset to zero here would be the exact same failure mode
being fixed, just relocated.

`confirmResumeCash` must not allow confirming the physical cash count against a total that hasn't
finished loading yet right after a restart — gate its confirm action on the ledger query's loading
state. Comparing against a stale/zero figure at the one moment this whole fix exists to protect
would silently recreate the bug.

Accepted cosmetic tradeoff: a brief `0` may render before the first query resolves on mount
(IndexedDB reads are single-digit milliseconds for a table this size) — not a money-correctness
issue, just a rendering one.

### Removed entirely

- `retainedCompletedSales` state in `Cashier.jsx`.
- `loadRetainedCompletedSales` / `saveRetainedCompletedSales` in `cashSales.js`.
- `syncRetainedSaleStatus` in `Cashier.jsx` — this existed only to keep the `localStorage` copy's
  void/refund status in sync with reality; Dexie's `completedSales.put()` already does this at the
  point of the void/refund itself, so there is no second cache left needing manual syncing.

`getCashSalesAmount`, `getGcashSalesAmount`, `getCashSalesAmountFromSources`,
`getGcashSalesAmountFromSources`, and `dedupedCompletedSales` in `cashSales.js` are unchanged —
they operate on a plain array of sale-shaped objects regardless of where that array came from.

## Testing

- New tests for `getShiftLedgerTotals` (via `fake-indexeddb/auto`, matching this repo's existing
  Dexie test convention): sums completed sales correctly; nets out voided sales entirely; nets
  partial refunds/exchanges via `adjustments`; respects the `sinceISO` lower bound (a sale from a
  previous, already-closed shift must not bleed into the current one).
- A direct regression test for the reported bug: populate `completedSales` with N sales across
  several statuses, then compute the total with **no in-memory or localStorage state involved at
  all** (simulating a fresh app restart) — proving the number is correct from Dexie alone, which is
  the actual guarantee this fix provides.
- Existing tests referencing `retainedCompletedSales`/`saveRetainedCompletedSales` updated or
  retired to match.

## Out of scope

- The web-mode checkout path (`server/index.js`) has no equivalent local cache to begin with — it
  is unaffected by this change.
- No changes to how `sales` are synced to the cloud, to `stock_movements`, or to any admin-facing
  report — this is purely about what the cashier terminal itself computes and prints for its own
  shift-close.
