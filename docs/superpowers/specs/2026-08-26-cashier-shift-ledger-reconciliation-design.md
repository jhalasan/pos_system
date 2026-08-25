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
- **A (chosen): Dexie as the single, continuous source of truth — on the build where it exists.**
  `completedCashSales`/`completedGcashSales` are recomputed from `cashierDb.completedSales` every
  time a sale completes, voids, or gets refunded — for both the live display and the final
  shift-close number, on the desktop app. (A later correction below narrows this: `Cashier.jsx`
  turns out to be shared with a non-desktop build with no Dexie at all, which the design accounts
  for via an additive override rather than a hard replacement — see "Nothing is removed" below.)

Option B still leaves two parallel representations of the same number that can drift from each
other, in a smaller way — which is the same structural mistake being removed. Option A means there
is exactly one *authoritative* number on desktop, computed the same way every time, rather than a
value that's authoritative right after a clean start but silently degrades across a crash/restart.
Dexie queries here are cheap (`cashierId` is already an indexed field; a shift's sale count tops
out in the low hundreds), so there is no meaningful performance cost.

## Changes

### New: `getShiftLedgerTotals(cashierId, sinceISO)` in `src/cashier-pos/offline/saleRepository.js`

Queries `cashierDb.completedSales.where('cashierId').equals(cashierId)`, filters to
`createdAt >= sinceISO`, and returns `{ cashSales, gcashSales }` by passing the resulting rows
straight into the existing `getCashSalesAmount`/`getGcashSalesAmount` from `cashSales.js`. Pure
composition — no new netting logic. `sinceISO` will always be `shiftSession.openedAt`, which is
stable across a resume (resuming reloads the same persisted session object; it does not create a
new one), so a plain time-window filter correctly scopes "this shift's sales" without needing a new
`sessionId` field on the Dexie row.

### Correction after further investigation: `Cashier.jsx` is shared with a non-desktop build

`Cashier.jsx` is used by two different builds, switched via `cashierApi`
(`src/cashier-pos/services/api.js:108`): the Tauri desktop app (`desktopCashierApi`, backed by
Dexie) and a browser/web-mode build (`webCashierApi`, backed only by direct server calls, no local
database at all). Per `VERCEL_DEPLOYMENT.md`, web-mode is not a real production point-of-sale
terminal — the deployed cashier experience is desktop-only — but the code path exists (likely for
running the cashier UI in a plain browser during development) and must not be broken. The Dexie
table this fix relies on does not exist in that build, so the design below routes through
`cashierApi` rather than importing Dexie access directly into `Cashier.jsx`, and treats "no Dexie
answer" as an expected, handled case rather than an error.

### `Cashier.jsx`: `completedCashSales`/`completedGcashSales` become async-corrected state

The existing synchronous computation (fed by `retainedCompletedSales` + `transactions`) is
**kept, unchanged, as an immediate fallback value** — it already works correctly for a normal,
uninterrupted session, and continuing to compute it synchronously means there is never a flash of
"0" while an async query is in flight.

On top of it, a `useEffect` (keyed on the same dependency the old memo already used —
`[transactions, shiftSession, user?.id]`, since `transactions` already changes at every point a
sale completes, voids, or is refunded) calls `cashierApi.getShiftLedgerTotals(user.id,
shiftSession.openedAt)`:

- **Desktop** (`desktopCashierApi.getShiftLedgerTotals`): queries `cashierDb.completedSales`
  (Dexie) and returns the authoritative `{ cashSales, gcashSales }`. This **overrides** the
  fallback value already showing — it is trusted completely once it resolves.
- **Web-mode** (`webCashierApi.getShiftLedgerTotals`): returns `null`, meaning "not supported on
  this build." The fallback value already computed is left in place, untouched — web-mode's
  behavior is provably identical to today's, because today's code path still runs and still owns
  the displayed number whenever the override doesn't arrive.
- **On any query failure** (thrown error, not a `null` response): also leave the fallback value in
  place, and surface a visible notification. A silent reset to zero here would be the exact same
  failure mode being fixed, just relocated.

A separate `shiftLedgerReady` boolean starts `false` on shift open/resume and is set `true` once
this query has resolved (successfully, as `null`, or by throwing) at least once for the current
shift session. `confirmResumeCash`'s confirm button and the shift-close Z-read preview/print
actions are gated on it — comparing the physical cash count against a total that hasn't had its one
chance to be corrected yet, right after a restart, is exactly the moment this fix exists to protect.
This does not block ongoing operation: `shiftLedgerReady` only guards the brief window right after
shift open/resume, not every subsequent sale during the shift.

### Nothing is removed — the fix is purely additive

Correcting the original plan: `retainedCompletedSales` state, `loadRetainedCompletedSales`/
`saveRetainedCompletedSales` (`cashSales.js`), `syncRetainedSaleStatus`, and every call site that
populates or updates them (`completeActiveTransaction`, and the two void/refund handlers) **all
stay exactly as they are today.** `syncRetainedSaleStatus` in particular is what keeps a voided/
refunded sale's status correct in `retainedCompletedSales` — deleting it, as originally planned,
would silently break void/refund accounting for web-mode's fallback path (which has no other way to
learn a sale's status changed), the exact kind of regression this whole exercise is meant to avoid.

On desktop, this old mechanism still runs in the background and computes a fallback value that
gets immediately overridden by the Dexie-backed result once the effect's query resolves (which, in
practice, is on essentially every render) — a small amount of redundant computation, not a
correctness risk, since the fallback value it produces is never trusted or displayed once the
override is available. On web-mode, it remains the only mechanism, completely unchanged from
today's behavior.

`getCashSalesAmount`, `getGcashSalesAmount`, `getCashSalesAmountFromSources`,
`getGcashSalesAmountFromSources`, and `dedupedCompletedSales` in `cashSales.js` are unchanged —
they operate on a plain array of sale-shaped objects regardless of where that array came from, and
are now used by both the existing fallback computation and the new Dexie-backed one.

## Testing

- New tests for `getShiftLedgerTotals` (via `fake-indexeddb/auto`, matching this repo's existing
  Dexie test convention): sums completed sales correctly; nets out voided sales entirely; nets
  partial refunds/exchanges via `adjustments`; respects the `sinceISO` lower bound (a sale from a
  previous, already-closed shift must not bleed into the current one).
- A direct regression test for the reported bug: populate `completedSales` with N sales across
  several statuses, then compute the total with **no in-memory or localStorage state involved at
  all** (simulating a fresh app restart) — proving the number is correct from Dexie alone, which is
  the actual guarantee this fix provides.
- No existing tests are removed or retired — nothing existing is deleted, per the correction above.

## Out of scope

- **Web-mode's own accuracy is not fixed.** `webCashierApi.getShiftLedgerTotals` returns `null`
  (an explicit "not supported" signal), so web-mode keeps today's `retainedCompletedSales`-based
  calculation, with all of its existing fragility, completely unchanged. Per `VERCEL_DEPLOYMENT.md`
  this build is not a real production point-of-sale terminal (the deployed cashier experience is
  desktop-only), and the client's reported problem is confirmed to be on the desktop terminals — so
  this is a deliberate scoping decision, not an oversight, made explicit here for a future session
  to revisit if web-mode ever needs the same guarantee.
- No changes to how `sales` are synced to the cloud, to `stock_movements`, or to any admin-facing
  report — this is purely about what the cashier terminal itself computes and prints for its own
  shift-close.
