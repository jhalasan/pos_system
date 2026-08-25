# Cashier Shift Ledger Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tauri desktop cashier's shift-close "Cash Sales"/"GCash Sales" figures always match the durable local sale ledger (Dexie), instead of a fragile `localStorage` cache that can silently undercount after a crash or restart — the confirmed root cause of a live client-reported discrepancy (terminal reported ₱1,347 vs. a hand-tally of ₱2,773 for the same shift).

**Architecture:** Add a new pure function, `getShiftLedgerTotals(cashierId, sinceISO)`, that queries the already-durable `cashierDb.completedSales` Dexie table and feeds the result into the existing, unchanged netting functions in `cashSales.js`. Wire it into the desktop `cashierApi` only. In `Cashier.jsx`, layer it as an **additive override** on top of the existing (unchanged) `localStorage`-based computation — the old computation keeps running everywhere as an instant fallback; the new Dexie-backed result overrides it the moment it resolves, on desktop only. Nothing existing is deleted.

**Tech Stack:** React (Cashier.jsx), Dexie/IndexedDB (`cashierDb`), `fake-indexeddb` for tests, Node's built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-08-26-cashier-shift-ledger-reconciliation-design.md`

## Global Constraints

- Must never cause a sale to go uncounted, and must never block a cashier from completing a sale or closing a shift — from the spec's explicit design constraint, itself from direct client instruction ("don't make them lose money" / "don't cause any serious problem in the business").
- Nothing currently functional may be removed or behaviorally changed — `retainedCompletedSales`, `loadRetainedCompletedSales`/`saveRetainedCompletedSales`, `syncRetainedSaleStatus`, and every call site that populates them stay exactly as they are today (per the spec's "Nothing is removed" correction).
- The web-mode cashier build (`webCashierApi`) is out of scope for the fix's accuracy — it must not be broken, but does not need to be made correct in this pass (spec's "Out of scope" section).
- Every step follows TDD: write the failing test first, watch it fail, then implement.

---

### Task 1: `getShiftLedgerTotals` — the Dexie-backed ledger query

**Files:**
- Modify: `src/cashier-pos/offline/saleRepository.js` (add import at top, add new exported function at the end, after line 462)
- Test: `tests/shift-ledger-totals.test.js` (new)

**Interfaces:**
- Produces: `export async function getShiftLedgerTotals(cashierId, sinceISO)` returning `Promise<{ cashSales: number, gcashSales: number }>`. Later tasks call this via `cashierApi.getShiftLedgerTotals(cashierId, sinceISO)`.

**Important correctness detail found during design review:** a split-payment sale is stored in `cashierDb.completedSales` with `paymentMethod: 'cash'` (not `'split'`) — `Cashier.jsx`'s `completeActiveTransaction` coerces it before sending to `cashierApi.completeSale`, because PocketBase's `payment_method` field is a locked `cash`/`gcash` enum with no `split` value. The actual cash/gcash breakdown survives in the sale's `splitPayments: { cash, gcash, gcashRef }` field. `cashSales.js`'s `getCashSalesAmount`/`getGcashSalesAmount` only look at `splitPayments` when `paymentMethod === 'split'` — so passing a raw Dexie row for a split sale straight into those functions would treat the *entire* total as cash, overcounting by the gcash portion. A non-split sale always has `splitPayments.gcash` parsed to `0` (the split-payment form's default state is `{ cash: '', gcash: '', gcashRef: '' }`, confirmed at `Cashier.jsx:158`), so `Number(sale.splitPayments?.gcash) > 0` reliably identifies a genuine split sale regardless of its stored `paymentMethod`. This must be corrected before handing rows to `getCashSalesAmount`/`getGcashSalesAmount`.

- [ ] **Step 1: Write the failing tests**

Create `tests/shift-ledger-totals.test.js`:

```js
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { getShiftLedgerTotals } from '../src/cashier-pos/offline/saleRepository.js'

// Root cause of a live client report: a cashier's hand-tallied shift total
// (P2,773) came out far higher than the terminal's own shift-close report
// (P1,347), while the underlying sales were confirmed complete and correct
// in the cloud. Traced to Cashier.jsx computing "Cash Sales" from a
// localStorage-cached running total that can silently lose entries across a
// crash/restart (see the design spec). getShiftLedgerTotals recomputes the
// figure from cashierDb.completedSales -- the same durable, transactional
// local table every sale/void/refund already writes to -- so the number is
// always correct regardless of what happened to any in-memory/localStorage
// state.

function completedSale(overrides = {}) {
  return {
    clientSaleId: overrides.clientSaleId || `sale-${Math.random().toString(36).slice(2)}`,
    cashierId: 'cashier-1',
    transactionNo: 'TXN-1',
    status: 'completed',
    paymentMethod: 'cash',
    totalAmount: 100,
    cashAmount: 100,
    gcashAmount: 0,
    splitPayments: { cash: 0, gcash: 0, gcashRef: '' },
    adjustments: [],
    createdAt: '2026-08-25T08:00:00.000Z',
    ...overrides,
  }
}

test('getShiftLedgerTotals sums completed cash and gcash sales separately', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'a', paymentMethod: 'cash', totalAmount: 100, cashAmount: 100 }),
    completedSale({ clientSaleId: 'b', paymentMethod: 'gcash', totalAmount: 50, gcashAmount: 50 }),
    completedSale({ clientSaleId: 'c', paymentMethod: 'cash', totalAmount: 25, cashAmount: 25 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 125)
  assert.equal(totals.gcashSales, 50)

  await cashierDb.delete()
})

test('getShiftLedgerTotals excludes voided sales entirely', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'a', totalAmount: 100, cashAmount: 100 }),
    completedSale({ clientSaleId: 'b', status: 'voided', totalAmount: 60, cashAmount: 60 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 100)

  await cashierDb.delete()
})

test('getShiftLedgerTotals nets a partial refund via adjustments', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.put(completedSale({
    clientSaleId: 'a',
    status: 'adjusted',
    totalAmount: 100,
    cashAmount: 100,
    adjustments: [{ type: 'refund', amount: 30 }],
  }))

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 70)

  await cashierDb.delete()
})

test('getShiftLedgerTotals splits a split-payment sale correctly instead of treating it as pure cash', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  // Stored exactly as Cashier.jsx/finalizeSaleLocally actually store a split
  // sale today: paymentMethod coerced to 'cash' (PocketBase's payment_method
  // enum has no 'split' value), with the true breakdown in splitPayments.
  await cashierDb.completedSales.put(completedSale({
    clientSaleId: 'a',
    paymentMethod: 'cash',
    totalAmount: 100,
    cashAmount: 60,
    gcashAmount: 40,
    splitPayments: { cash: 60, gcash: 40, gcashRef: 'REF123' },
  }))

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 60, 'must use the cash portion, not the full total')
  assert.equal(totals.gcashSales, 40, 'must use the gcash portion')

  await cashierDb.delete()
})

test('getShiftLedgerTotals respects the sinceISO lower bound', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'before', totalAmount: 999, cashAmount: 999, createdAt: '2026-08-24T23:00:00.000Z' }),
    completedSale({ clientSaleId: 'after', totalAmount: 50, cashAmount: 50, createdAt: '2026-08-25T01:00:00.000Z' }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 50, 'a sale from a previous, already-closed shift must not bleed into this one')

  await cashierDb.delete()
})

test('getShiftLedgerTotals only counts the given cashier', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  await cashierDb.completedSales.bulkPut([
    completedSale({ clientSaleId: 'mine', cashierId: 'cashier-1', totalAmount: 40, cashAmount: 40 }),
    completedSale({ clientSaleId: 'theirs', cashierId: 'cashier-2', totalAmount: 999, cashAmount: 999 }),
  ])

  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 40)

  await cashierDb.delete()
})

test('getShiftLedgerTotals returns zeros for a missing cashierId', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()
  const totals = await getShiftLedgerTotals('', '2026-08-25T00:00:00.000Z')
  assert.deepEqual(totals, { cashSales: 0, gcashSales: 0 })
  await cashierDb.delete()
})

// This is the actual guarantee the whole fix provides: the number is
// correct from Dexie alone, with zero dependency on any in-memory or
// localStorage state -- i.e. it survives exactly the kind of crash/restart
// that caused the original bug.
test('getShiftLedgerTotals reconstructs the full shift total with no in-memory or localStorage state involved', { concurrency: false }, async () => {
  await cashierDb.delete()
  await initializeCashierDb()

  const sales = Array.from({ length: 20 }, (_, i) => completedSale({
    clientSaleId: `sale-${i}`,
    totalAmount: 10,
    cashAmount: 10,
    createdAt: `2026-08-25T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:00:00.000Z`,
  }))
  await cashierDb.completedSales.bulkPut(sales)

  // No localStorage global exists in this test at all -- simulating a fresh
  // process where nothing but the Dexie table survived.
  const totals = await getShiftLedgerTotals('cashier-1', '2026-08-25T00:00:00.000Z')
  assert.equal(totals.cashSales, 200)

  await cashierDb.delete()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/shift-ledger-totals.test.js`
Expected: every test fails with `getShiftLedgerTotals is not a function` (or a similar import error), since the function doesn't exist yet.

- [ ] **Step 3: Implement `getShiftLedgerTotals`**

In `src/cashier-pos/offline/saleRepository.js`, add this import alongside the existing ones at the top of the file (after the existing `import { mintTransactionNumber } from './transactionNumber.js'` line):

```js
import { getCashSalesAmount, getGcashSalesAmount } from '../utils/cashSales.js'
```

Then append this to the end of the file (after the closing `}` of `adjustLocalSale`, currently the last line):

```js

// A sale that used the split-payment flow is stored with paymentMethod
// coerced to 'cash' (see finalizeSaleLocally / Cashier.jsx's
// completeActiveTransaction -- PocketBase's payment_method field is a
// locked cash/gcash enum with no 'split' value), with the true cash/gcash
// breakdown surviving in splitPayments. getCashSalesAmount/
// getGcashSalesAmount only consult splitPayments when paymentMethod is
// literally 'split' -- so a raw completedSales row for a split sale must be
// relabeled before netting, or its entire total gets counted as cash,
// overcounting by the gcash portion. A non-split sale always has
// splitPayments.gcash parsed to 0 (the split-payment form's default state),
// so this check cannot misfire on a genuine pure-cash or pure-gcash sale.
function withTrueSplitPaymentMethod(sale) {
  if (Number(sale?.splitPayments?.gcash) > 0) {
    return { ...sale, paymentMethod: 'split' }
  }
  return sale
}

// Recomputes a shift's Cash Sales/GCash Sales totals directly from
// cashierDb.completedSales -- the same durable, transactional local table
// every sale, void, and refund already writes to (see finalizeSaleLocally,
// voidLocalSale, adjustLocalSale above) -- rather than trusting a separate
// running cache that can silently drift or get lost across a crash/restart.
// `sinceISO` is always the current shift's `openedAt`; resuming a shift
// reloads the same persisted session object rather than creating a new one,
// so a plain time-window filter correctly scopes "this shift's sales"
// without needing a dedicated sessionId field on the row.
export async function getShiftLedgerTotals(cashierId, sinceISO) {
  if (!cashierId) return { cashSales: 0, gcashSales: 0 }
  if (!(await hasTable('completedSales'))) return { cashSales: 0, gcashSales: 0 }

  const since = String(sinceISO || '')
  const sales = (await cashierDb.completedSales.where('cashierId').equals(cashierId).toArray())
    .filter((sale) => String(sale.createdAt || '') >= since)
    .map(withTrueSplitPaymentMethod)

  return {
    cashSales: getCashSalesAmount(sales),
    gcashSales: getGcashSalesAmount(sales),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/shift-ledger-totals.test.js`
Expected: all 8 tests pass.

- [ ] **Step 5: Run the full offline suite to confirm no regressions**

Run: `npm run test:offline`
Expected: every existing test still passes, plus the 8 new ones (total count increases by 8 from whatever it was before this task).

- [ ] **Step 6: Commit**

```bash
git add src/cashier-pos/offline/saleRepository.js tests/shift-ledger-totals.test.js
git commit -m "$(cat <<'EOF'
feat(cashier): add Dexie-backed shift ledger total reconciliation

getShiftLedgerTotals recomputes a shift's Cash Sales/GCash Sales from
cashierDb.completedSales -- the durable local table every sale/void/
refund already writes to -- instead of trusting a separate cache.
Handles the split-payment/paymentMethod-coercion edge case explicitly
so a split sale isn't overcounted as pure cash.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `getShiftLedgerTotals` into `cashierApi`

**Files:**
- Modify: `src/cashier-pos/services/desktopApi.js` (add import, add method to `desktopCashierApi`)
- Modify: `src/cashier-pos/services/api.js` (add method to `webCashierApi`)

**Interfaces:**
- Consumes: `getShiftLedgerTotals(cashierId, sinceISO)` from Task 1.
- Produces: `cashierApi.getShiftLedgerTotals(cashierId, sinceISO)` — resolves to `{ cashSales, gcashSales }` on desktop, `null` on web-mode (meaning "not supported, caller must use its own fallback"). Task 3 depends on this exact contract.

No new automated test for this task — this codebase's existing convention (see `tests/sale-validation-guards.test.js` and the rest of the cashier test suite) is to test `saleRepository.js`'s pure functions directly, not `desktopCashierApi`'s thin wrapper methods, since `desktopApi.js` pulls in heavy runtime/sync dependencies unsuited to isolated unit tests. This wiring is verified by lint, the full build, and the manual walkthrough in Task 3's Step 5.

- [ ] **Step 1: Add the import in `desktopApi.js`**

In `src/cashier-pos/services/desktopApi.js`, change:

```js
import {
  adjustLocalSale,
  finalizeSaleLocally,
  findLocalSale,
  findLocalSaleByTransactionNo,
  getCompletedSales,
  getPendingSales,
  voidLocalSale,
} from '../offline/saleRepository'
```

to:

```js
import {
  adjustLocalSale,
  finalizeSaleLocally,
  findLocalSale,
  findLocalSaleByTransactionNo,
  getCompletedSales,
  getPendingSales,
  getShiftLedgerTotals,
  voidLocalSale,
} from '../offline/saleRepository'
```

- [ ] **Step 2: Add the method to `desktopCashierApi`**

In `src/cashier-pos/services/desktopApi.js`, find the end of the `adjustCompletedSale` method (it currently ends the `desktopCashierApi` object literal — the line `return toCashierSale(adjustedSale)\n  },` immediately followed by the object's closing `}`). Add a new method right after it, before the closing `}`:

```js
  async adjustCompletedSale({ saleId, cashierId, authorization, type, items, reason, note, restock = true }) {
    // ... existing body, unchanged ...
    return toCashierSale(adjustedSale)
  },

  async getShiftLedgerTotals(cashierId, sinceISO) {
    return getShiftLedgerTotals(cashierId, sinceISO)
  },
}
```

(Only the new `getShiftLedgerTotals` method and the trailing `}` are new — do not modify `adjustCompletedSale`'s existing body.)

- [ ] **Step 3: Add the web-mode fallback in `api.js`**

In `src/cashier-pos/services/api.js`, inside the `webCashierApi` object literal, add this method (placement anywhere in the object is fine; adding it right after `adjustCompletedSale` matches Task 2's desktop change):

```js
  adjustCompletedSale: () => {
    throw new Error('Refund and exchange adjustments are available in the desktop cashier app.')
  },
  // Web-mode has no local database to reconcile against (every sale goes
  // straight to the server, no offline queue) -- returning null signals
  // "not supported here" so Cashier.jsx falls back to its existing
  // localStorage-based calculation, unchanged from today's behavior. See
  // the design spec's "Out of scope" section: web-mode's own accuracy is a
  // deliberate, documented non-goal of this fix.
  getShiftLedgerTotals: async () => null,
```

- [ ] **Step 4: Lint the two changed files**

Run: `npx eslint src/cashier-pos/services/desktopApi.js src/cashier-pos/services/api.js`
Expected: no errors.

- [ ] **Step 5: Run the full offline suite to confirm no regressions**

Run: `npm run test:offline`
Expected: same pass count as the end of Task 1 (this task adds no new tests, only wiring).

- [ ] **Step 6: Commit**

```bash
git add src/cashier-pos/services/desktopApi.js src/cashier-pos/services/api.js
git commit -m "$(cat <<'EOF'
feat(cashier): expose getShiftLedgerTotals via cashierApi

Desktop delegates to the new Dexie-backed saleRepository function.
Web-mode returns null (no local database to reconcile against) so
Cashier.jsx can fall back to its existing calculation unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `Cashier.jsx` — layer the authoritative override on top of the existing calculation

**Files:**
- Modify: `src/cashier-pos/pages/Cashier.jsx`

**Interfaces:**
- Consumes: `cashierApi.getShiftLedgerTotals(cashierId, sinceISO)` from Task 2.
- Produces: `completedCashSales`, `completedGcashSales` (unchanged names/types — every existing reader of these two values, e.g. `buildShiftCloseDraft`, `closeShift`, `expectedShiftCash`, elsewhere in this same file, needs no changes at all). New: `shiftLedgerReady` (boolean), used only within this task.

This task has no new automated test (no test file exists for this component today, matching this codebase's established pattern of testing pure utilities/repository functions rather than large React components — see `ls tests/` has no `Cashier.jsx`-named test). Verification is the full regression suite (proving nothing else broke), lint, all three builds, and a mandatory manual walkthrough (Step 5) before this task is considered done — this is the highest-risk file change in the whole plan, so do not skip Step 5.

- [ ] **Step 1: Add the new state**

In `src/cashier-pos/pages/Cashier.jsx`, find this line (around line 512):

```js
  const [retainedCompletedSales, setRetainedCompletedSales] = useState(() => loadRetainedCompletedSales(user?.id));
```

Leave it exactly as-is (do not remove or modify), and add two new lines directly after it:

```js
  const [retainedCompletedSales, setRetainedCompletedSales] = useState(() => loadRetainedCompletedSales(user?.id));
  // Authoritative override from the Dexie-backed ledger (desktop only --
  // see cashierApi.getShiftLedgerTotals). null means "no override yet, use
  // the existing retainedCompletedSales-based calculation below." Never
  // reset to null on a query failure -- only a fresh successful result or a
  // new/closed shift session replaces it, so a transient error can never
  // make a correct number disappear.
  const [shiftLedgerOverride, setShiftLedgerOverride] = useState(null);
  // Guards confirmResumeCash and the shift-close Z-read preview/print
  // against acting on a total that hasn't had its one chance yet to be
  // corrected by the override -- see the effect below. Does not otherwise
  // affect normal ringing-up during a shift.
  const [shiftLedgerReady, setShiftLedgerReady] = useState(false);
```

- [ ] **Step 2: Rename the two existing memos to `...Fallback` and derive the final values**

Find this block (around lines 690-731):

```js
  const completedCashSales = useMemo(() => {
    const transactionSales = transactions
      .filter((txn) => txn?.status === 'completed')
      .map((txn) => ({
        ...(txn?.completedSale || {}),
        status: txn?.completedSale?.status || 'completed',
        rawStatus: txn?.completedSale?.rawStatus || 'completed',
      }))
      .filter(Boolean);
    const currentSessionId = String(shiftSession?.id || '');
    const salesForCurrentSession = (sales) => sales.filter((sale) => (
      !currentSessionId || String(sale?.sessionId || sale?.session_id || '') === currentSessionId
    ));
    return getCashSalesAmountFromSources({
      retainedSales: salesForCurrentSession(retainedCompletedSales),
      currentSales: salesForCurrentSession(transactionSales),
      cashierId: user?.id,
    });
  }, [retainedCompletedSales, transactions, shiftSession, user?.id]);

  // Informational only, for the Z-read's GCash transparency line -- GCash
  // never touches the physical drawer, so this must stay entirely separate
  // from completedCashSales and the cash-count reconciliation math above.
  const completedGcashSales = useMemo(() => {
    const transactionSales = transactions
      .filter((txn) => txn?.status === 'completed')
      .map((txn) => ({
        ...(txn?.completedSale || {}),
        status: txn?.completedSale?.status || 'completed',
        rawStatus: txn?.completedSale?.rawStatus || 'completed',
      }))
      .filter(Boolean);
    const currentSessionId = String(shiftSession?.id || '');
    const salesForCurrentSession = (sales) => sales.filter((sale) => (
      !currentSessionId || String(sale?.sessionId || sale?.session_id || '') === currentSessionId
    ));
    return getGcashSalesAmountFromSources({
      retainedSales: salesForCurrentSession(retainedCompletedSales),
      currentSales: salesForCurrentSession(transactionSales),
      cashierId: user?.id,
    });
  }, [retainedCompletedSales, transactions, shiftSession, user?.id]);
```

Replace it with (only the two `const` names change, from `completedCashSales`/`completedGcashSales` to `completedCashSalesFallback`/`completedGcashSalesFallback`; the bodies are byte-for-byte identical, plus two new derived consts and the reconciliation effect appended after):

```js
  const completedCashSalesFallback = useMemo(() => {
    const transactionSales = transactions
      .filter((txn) => txn?.status === 'completed')
      .map((txn) => ({
        ...(txn?.completedSale || {}),
        status: txn?.completedSale?.status || 'completed',
        rawStatus: txn?.completedSale?.rawStatus || 'completed',
      }))
      .filter(Boolean);
    const currentSessionId = String(shiftSession?.id || '');
    const salesForCurrentSession = (sales) => sales.filter((sale) => (
      !currentSessionId || String(sale?.sessionId || sale?.session_id || '') === currentSessionId
    ));
    return getCashSalesAmountFromSources({
      retainedSales: salesForCurrentSession(retainedCompletedSales),
      currentSales: salesForCurrentSession(transactionSales),
      cashierId: user?.id,
    });
  }, [retainedCompletedSales, transactions, shiftSession, user?.id]);

  // Informational only, for the Z-read's GCash transparency line -- GCash
  // never touches the physical drawer, so this must stay entirely separate
  // from completedCashSales and the cash-count reconciliation math above.
  const completedGcashSalesFallback = useMemo(() => {
    const transactionSales = transactions
      .filter((txn) => txn?.status === 'completed')
      .map((txn) => ({
        ...(txn?.completedSale || {}),
        status: txn?.completedSale?.status || 'completed',
        rawStatus: txn?.completedSale?.rawStatus || 'completed',
      }))
      .filter(Boolean);
    const currentSessionId = String(shiftSession?.id || '');
    const salesForCurrentSession = (sales) => sales.filter((sale) => (
      !currentSessionId || String(sale?.sessionId || sale?.session_id || '') === currentSessionId
    ));
    return getGcashSalesAmountFromSources({
      retainedSales: salesForCurrentSession(retainedCompletedSales),
      currentSales: salesForCurrentSession(transactionSales),
      cashierId: user?.id,
    });
  }, [retainedCompletedSales, transactions, shiftSession, user?.id]);

  // The fallback above is kept running unconditionally (it is web-mode's
  // ONLY source of this number, and costs nothing extra to compute on
  // desktop) -- these two are what every other part of this file actually
  // reads. On desktop, shiftLedgerOverride will hold the Dexie-backed
  // authoritative value on essentially every render; on web-mode it stays
  // null forever (cashierApi.getShiftLedgerTotals resolves to null there),
  // so these are provably identical to today's completedCashSales/
  // completedGcashSales for that build.
  const completedCashSales = shiftLedgerOverride ? shiftLedgerOverride.cashSales : completedCashSalesFallback;
  const completedGcashSales = shiftLedgerOverride ? shiftLedgerOverride.gcashSales : completedGcashSalesFallback;

  // Recomputes the authoritative Dexie-backed totals every time a sale
  // completes, voids, or is refunded within this shift (transactions
  // changes at every one of those points already) -- see
  // getShiftLedgerTotals's own comment for why this is trustworthy where
  // the fallback above is not. A thrown error or a null result (web-mode)
  // leaves shiftLedgerOverride untouched, so the fallback value already
  // showing is never replaced with something worse.
  useEffect(() => {
    let cancelled = false;
    if (!shiftSession || !user?.id) {
      setShiftLedgerOverride(null);
      setShiftLedgerReady(true);
      return () => { cancelled = true; };
    }
    setShiftLedgerReady(false);
    Promise.resolve(cashierApi.getShiftLedgerTotals?.(user.id, shiftSession.openedAt))
      .then((result) => {
        if (cancelled || !result) return;
        setShiftLedgerOverride(result);
      })
      .catch((err) => {
        if (cancelled) return;
        showNotification(`Unable to verify cash sales against the local ledger (${err?.message || err}). Showing the last known total.`);
      })
      .finally(() => {
        if (!cancelled) setShiftLedgerReady(true);
      });
    return () => { cancelled = true; };
  }, [transactions, shiftSession, user?.id]);
```

- [ ] **Step 3: Reset the override when a shift closes**

Find this block inside `closeShift` (around line 1404-1407):

```js
      localStorage.removeItem(shiftStorageKey(user?.id));
      clearCashierTransactions(user?.id);
      setRetainedCompletedSales([]);
      saveRetainedCompletedSales([], user?.id);
```

Replace it with:

```js
      localStorage.removeItem(shiftStorageKey(user?.id));
      clearCashierTransactions(user?.id);
      setRetainedCompletedSales([]);
      saveRetainedCompletedSales([], user?.id);
      setShiftLedgerOverride(null);
```

(This is defense-in-depth, not strictly required — the reconciliation effect from Step 2 will also reset it on its own once `shiftSession` becomes `null` a few lines later in the same function — but making it explicit here means a reader doesn't have to trace the effect's dependency array to see that a closed shift's override can never leak into the next one.)

- [ ] **Step 4: Gate `confirmResumeCash` and the shift-close draft on `shiftLedgerReady`**

Find this block (around line 1453):

```js
            <button className="btn btn-primary" onClick={confirmResumeCash} disabled={resumeCashSaving}>
              {resumeCashSaving ? 'Confirming...' : 'Resume Session'}
            </button>
```

Replace it with:

```js
            <button className="btn btn-primary" onClick={confirmResumeCash} disabled={resumeCashSaving || !shiftLedgerReady}>
              {resumeCashSaving ? 'Confirming...' : !shiftLedgerReady ? 'Verifying sales…' : 'Resume Session'}
            </button>
```

Find the start of `buildShiftCloseDraft` (around line 1239):

```js
  const buildShiftCloseDraft = (skipCashCount = false) => {
    const shouldSkipCashCount = skipCashCount === true;
```

Replace it with:

```js
  const buildShiftCloseDraft = (skipCashCount = false) => {
    if (!shiftLedgerReady) {
      setShiftError('Verifying today\'s sales against the local ledger — try again in a moment.');
      return null;
    }
    const shouldSkipCashCount = skipCashCount === true;
```

(This single guard covers the Z-read preview, print, and the actual shift close, since `prepareShiftClosePreview`, `printShiftCloseDraft`, and `closeShift` all call `buildShiftCloseDraft` — confirmed by their call sites at lines 1305, 1319, and 1339 respectively.)

- [ ] **Step 5: Manual verification (required — do not skip)**

This file has no automated component test, and this is the highest-risk change in the plan. Use the `run` skill to launch the actual desktop cashier app and walk through:

1. Log in as a cashier, open a shift with a starting cash amount.
2. Ring up 2-3 sales: at least one pure cash, one pure GCash, and one split payment (if the UI's Split Payment toggle is available). Confirm each completes normally and prints/shows a receipt as before.
3. Open the shift-close (Z-read) preview. Confirm "Cash Sales" and "GCash Sales" match what you actually rang up (the split sale's cash and gcash portions should each land in the correct bucket, not both counted as cash).
4. Void one of the sales via the transaction lookup flow. Re-open the Z-read preview and confirm the voided sale's amount is now excluded.
5. Close the terminal application entirely (simulating a crash/restart) without closing the shift, then reopen it and log back in. Confirm the "Resume Session" cash-check modal appears, its "System expects" figure still reflects the sales rung up before the restart (not reset to a smaller/zero value), and the confirm button is enabled (not stuck on "Verifying sales…").
6. Close the shift for real. Confirm the printed Z-read total is correct and the shift closes without error.

If any step shows a wrong number or a stuck/broken UI, stop and fix before proceeding — do not move to Step 6.

- [ ] **Step 6: Run the full regression suite, lint, and all three builds**

Run, in order:

```bash
npm run test:offline
npm run test:vercel
npx eslint src/cashier-pos/pages/Cashier.jsx
npm run build
npm run build:vercel
npm run build:cashier
```

Expected: `test:offline` and `test:vercel` show the same pass counts as the end of Task 2 (this task adds no new automated tests — Cashier.jsx is not unit-tested in this codebase; correctness here rests on Step 5's manual walkthrough plus these regression/build checks proving nothing else broke); lint clean; all three builds succeed.

- [ ] **Step 7: Commit**

```bash
git add src/cashier-pos/pages/Cashier.jsx
git commit -m "$(cat <<'EOF'
fix(cashier): override shift Cash/GCash Sales with the Dexie ledger

The existing localStorage-based calculation is kept, unchanged, as an
instant fallback (and remains web-mode's only source of this number).
On desktop, the new Dexie-backed getShiftLedgerTotals overrides it the
moment it resolves, correcting the fragile total that caused a live
client-reported discrepancy (terminal reported P1,347 vs a hand-tally
of P2,773 for the same shift, with cloud sales confirmed complete and
correct). confirmResumeCash and the shift-close Z-read are gated so
neither can act on an unverified total right after a restart.

Manually verified: cash/gcash/split sales, a void, a simulated
terminal restart mid-shift, and a full shift close all produce correct
figures.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Final verification and audit register entry

**Files:**
- Modify: `POS_AUDIT_REGISTER.md` (new entry)

- [ ] **Step 1: Re-run the full verification sweep one more time from a clean state**

```bash
npm run test:offline
npm run test:vercel
npm run lint
npm run build
npm run build:vercel
npm run build:cashier
```

Expected: all green. This re-run (after three separate commits) is the final gate before considering the fix release-ready — if anything regressed across the three tasks' commits, it surfaces here.

- [ ] **Step 2: Add a register entry**

Following the exact style of the "Live-support fix, 2026-08-26" section already in `POS_AUDIT_REGISTER.md` (which documented the timezone bug found earlier in this same investigation), append a new entry directly after it:

```markdown

**M27. HIGH — ✅ FIXED. The cashier terminal's own shift-close "Cash Sales" figure could silently
undercount, with no relationship to the underlying sales.** `Cashier.jsx`'s `completedCashSales`/
`completedGcashSales` — printed on the Z-read and written to the durable cash-audit log — were
computed entirely from `retainedCompletedSales`, a JSON blob in raw `localStorage`
(`src/cashier-pos/utils/cashSales.js`). Two real defects fed into it: `saveRetainedCompletedSales`'s
`localStorage.setItem` had no error handling (a sale already recorded successfully in the cloud
could silently fail to register in the local running total), and `loadRetainedCompletedSales`'s
parse failure silently returned `[]` on any corruption, resetting an entire shift's tally with no
warning. Either failure reproduces the exact client-reported symptom: a terminal-reported total
lower than reality, with the drawer's actual cash correct (since every sale genuinely happened) —
surfacing as unexplained "excess" cash rather than a real shortage. Compounding this,
`confirmResumeCash` (the post-restart cash-count check) treated any mismatch as a cash-handling
event and silently booked a compensating Cash In/Out adjustment, papering over the data-loss bug
as if it were a physical counting mistake.

This app already had a proper, durable, transactional local store for exactly this data —
`cashierDb.completedSales` (Dexie), written atomically in the same transaction as every sale, void,
and refund (`saleRepository.js`) — it was simply never used for this figure. Fix: new
`getShiftLedgerTotals(cashierId, sinceISO)` recomputes the total from that table and is layered as
an authoritative override on top of the existing calculation (which stays unchanged, and remains
the only source of this number for the separate, non-production web-mode cashier build — see the
design spec's explicit scoping). Handles a subtlety found during design review: a split-payment
sale is stored with `paymentMethod` coerced to `'cash'` (PocketBase's `payment_method` field has no
`split` value), which would otherwise cause `getCashSalesAmount` to count its entire total as cash
instead of splitting it correctly — corrected before netting.

New tests: `tests/shift-ledger-totals.test.js` (8 tests: correct cash/gcash summation, void
exclusion, partial-refund netting, the split-payment edge case, the `sinceISO` boundary, per-cashier
scoping, and a direct reconstruction-with-no-in-memory-state regression test proving the actual
guarantee this fix provides). Manually verified on the desktop app: cash/gcash/split sales, a void,
a simulated mid-shift terminal restart, and a full shift close all produce correct figures.
Design spec: `docs/superpowers/specs/2026-08-26-cashier-shift-ledger-reconciliation-design.md`.

**Not yet resolved:** whether this specific fix, combined with M25/M26's timezone fix, fully
explains the client's original P1,347 vs P2,773 discrepancy is still unconfirmed pending the
client's next shift close — this closes every mechanism found during investigation, but the
original two numbers were never directly reproduced from the live data at the time.
```

- [ ] **Step 3: Commit**

```bash
git add POS_AUDIT_REGISTER.md
git commit -m "$(cat <<'EOF'
docs: record M27 cashier shift ledger fix in the audit register

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After this plan

Do **not** push or tag a release as part of this plan. Given how much this touches the core
cash-reconciliation path of a system already live with a paying client, stop after Task 4's commit
and hand control back for an explicit decision on when to push/release — do not assume the same
immediate "push it for the next business day" instruction from the earlier timezone fix applies
here without being asked again.
