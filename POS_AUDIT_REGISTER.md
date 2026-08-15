# POS System Audit Register

Status as of 2026-08-15 (re-audit pass; supersedes `PENDING_REVENUE_STOCK_FIXES.md`, which
tracked only the revenue/stock half of the first audit). This is now the single source of truth
for open findings across the whole system — security, money-correctness, sync/request-volume,
and hygiene. Renamed because the scope is no longer revenue/stock-only.

## How this document is organized

- **Verified fixed** — merged to `main`, re-confirmed still true in this pass.
- **S — Security**, **M — Money correctness**, **T — Sync/request-volume**, **H — Hygiene.**
  Each item has a severity, exact file:line, and what was actually read (not assumed).
- **Locked-in decisions** — do not re-litigate without the client.
- **How to resume.**

Full original plan detail (first audit's ground truth) lives at
`C:\Users\ASUS\.claude\plans\the-client-has-a-golden-lobster.md`. The current remediation plan
(this re-audit's ground truth) lives at
`C:\Users\ASUS\.claude\plans\run-another-audit-check-golden-wave.md`.

## Locked-in decisions (do not re-litigate without the client)

- Transaction numbers stay **all-numeric** (BIR/bookkeeping safety).
- Refunds net out of **both revenue and units-sold/FSN analytics**, not revenue alone.
- Rate limiter is tuned for **1-2 terminals**, self-tuning from there (already shipped).
- Remediation order for this pass: **security first, then money-correctness, then the
  sync/request-volume work, then hygiene.** The security items were previously deferred; they
  are promoted because the manager-approval control that money-correctness fixes (refund/void)
  depend on is currently defeatable by any cashier (see S1).

## Verified fixed (merged to `main`)

- **Rate limiting** (`f6eab1b`, 2026-08-15): `src/utils/pocketbaseGovernor.js` (token bucket +
  AIMD, escalating cooldown, priority lanes, keyed single-flight, cross-window persistence via
  `localStorage`), `src/utils/pacedPocketBase.js` (wraps every `new PocketBase(...)` site — all
  10 across both apps), `src/utils/pocketbaseRateLimit.js` rewritten as a zero-behavior-change
  facade. 103/103 offline tests passing at the time.
- **Stock reconciler rewrite** (`5d3967e`): `src/utils/stockMovementReconciler.js` sorts by
  `created` (server autodate) not `created_at` (client timestamp); reads a bounded window (50
  movements) instead of a product's entire history; `findStockMovement` only treats a genuine
  404 as "no movement yet" — any other error now fails loudly instead of being swallowed by
  `.catch(() => null)`, which was the direct cause of stock double-deduction on retry.
  Chain-mismatch detection is a non-blocking diagnostic log, not a gate (an earlier draft made it
  a hard gate and was caught in review as a regression). 114/114 offline tests passing.

Both re-confirmed accurate in this pass — no regressions.

---

## S — Security (new to this register; previously deferred, now promoted)

**S1. CRITICAL — Manager approval barcodes are readable by cashiers. ✅ FIXED (this session,
online-only approval, per client decision).**
Was: `scripts/configure-pocketbase-rules.mjs:15,87-93` set
`authorization_barcodes.listRule = '@request.auth.role = "cashier" || ... "admin"'`, overriding
the admin-only (`null`) rule in `pocketbase/pb_schema.json`. The cashier client bulk-downloaded
them into IndexedDB (`desktopApi.js:453-477`, old line numbers), and did the same for `users`
(`:171-177`, old), leaking every manager's `92`-prefixed `void_barcode`
(`server/formatters.js:196-199`).
Fix: `authorization_barcodes` and `users` PB rules are now admin-only /
self-or-admin (`scripts/configure-pocketbase-rules.mjs`). `authorizeManagerApproval` in
`src/cashier-pos/services/desktopApi.js` no longer queries either collection directly or caches
barcodes/password hashes locally — it calls the existing server-mediated
`POST /api/cashier/authorize-void` (`server/index.js:915`), which verifies against PocketBase
using the server's own superuser credentials and never returns the code list. This makes manager
approval **online-only** (client decision: no offline fallback, rather than caching a salted hash
locally) — void/refund/cash-out approval now requires connectivity. `loginWithBarcode`'s online
verification and the quick-login account list were also moved off direct `users` queries onto
`POST /api/cashier/auth/barcode` and `GET /api/cashier/quick-login-accounts` (the latter now
strips `cashierBarcode`/hides `92`-prefixed accounts server-side, `server/index.js`) so the
tightened `users` rule doesn't break normal cashier-switching. `npm run test:offline` (114/114)
and `npm run test:vercel` (3/3) still pass. **Not yet done:** S3 still applies to these same
endpoints — `authorize-void` has no rate limit yet, so this fix closes the bulk-read leak but not
the brute-force vector; that lands with S3.

**S2. CRITICAL — Live superuser credentials committed. ⚠️ FILE FIXED (this session); PASSWORD
ROTATION STILL REQUIRED — action for the client, not something this session could do.**
Was: `.env.example:3-8` held `POCKETBASE_URL=https://nexasystems.pockethost.io`,
`POCKETBASE_SUPERUSER_EMAIL=admin@email.com`, `POCKETBASE_SUPERUSER_PASSWORD=admin123`,
`DEFAULT_CASHIER_PASSWORD=cashier123` — byte-identical to the working `.env`, so these were real
values, not placeholders. `.env` itself is correctly gitignored and was never committed;
`.env.example` was tracked and these values are in git history already.
Fix: `.env.example` now holds placeholders only (`replace-with-a-secret` / a generic
`your-pocketbase-host.pockethost.io`). **This does not remove the real values from git
history** — anyone with a clone still has `admin@email.com` / `admin123` from an old commit.
**Required, not yet done (needs the client's own PocketHost dashboard access):**
1. Rotate the PocketBase superuser password immediately (PocketHost dashboard → the
   `nexasystems` project → superuser account) and update the real `.env` (untracked, safe) with
   the new value.
2. Rotate `DEFAULT_CASHIER_PASSWORD` similarly — any staff account created without an explicit
   password used this value.
3. Decide whether to rewrite git history to purge the old commit(s) (`git filter-repo` or BFG) —
   optional once rotated, since the exposed password will no longer work, but the URL + old
   credential pattern stays visible in history either way unless rewritten.

**S3. HIGH — All `/api/cashier/*` routes are unauthenticated. ✅ FIXED (this session).**
Was: `server/index.js:837-841` short-circuited the auth middleware for any path starting
`/cashier/`. Reachable with no token: `POST /cashier/sales` (ring sales, mutate stock),
`POST /cashier/sales/:id/void`, `GET /cashier/quick-login-accounts`,
`POST /cashier/auth/barcode`, and `POST /cashier/authorize-void` with no rate limit — barcodes
are `90` + timestamp + 2 digits, brute-forceable.
Fix: added `authenticateCashierToken` (`server/pocketbase.js`, mirrors the existing
`authenticateAdminToken`) and applied it in the `/api` middleware for every `/cashier/*` path
except the genuinely pre-login ones (`/cashier/auth/login`, `/cashier/auth/barcode` — registered
earlier in the file so they never reach this middleware at all; `/cashier/quick-login-accounts`
— explicit allowlist entry, needed for the account-switcher screen before anyone is
authenticated). Barcode login (`/cashier/auth/barcode`) previously returned no session token at
all since it looked the user up with the server's own superuser client rather than authenticating
as them — fixed by minting a real 12-hour session via PocketBase `impersonate()`, so a
barcode-logged-in terminal can now actually authenticate its subsequent calls. Both web
(`src/cashier-pos/services/api.js`) and desktop (`src/cashier-pos/services/desktopApi.js`) clients
now attach the resulting bearer token. Added a simple in-memory sliding-window rate limiter (8
attempts / 5 min / IP, single-process, no new dependency) on `/cashier/auth/login`,
`/cashier/auth/barcode`, and `/cashier/authorize-void`. Also fixed an unrelated latent bug this
work exposed: `server/index.js`'s module-level `app.listen(PORT)` wasn't `unref()`'d, so any
script or test importing the module outside Vercel mode got an orphan listener that kept the
process alive forever. New regression test `tests/cashier-api-auth.test.js` (added to
`test:offline`) asserts `/cashier/sales` and `/cashier/authorize-void` 401 with no token and that
`/cashier/auth/login` remains reachable. `npm run test:offline` (117/117) and `npm run
test:vercel` (3/3) pass.

**S4. HIGH — `/api/support/tickets` is an open mail relay.** Mounted at `server/index.js:144`,
before the auth middleware. `api/support/tickets.js:15-21` sets
`Access-Control-Allow-Origin: '*'`. No auth, no rate limit, no captcha, 5 attachments accepted —
can drain the Gmail App Password credential.

**S5. HIGH — `PATCH /api/cashiers/:id` escalates privileges by omission. ✅ FIXED (this
session).**
Was: `server/formatters.js:193-212` ran every PATCH through the same `cashierPayload` built for
POST (a brand-new record, where defaults are correct). `status: input.status || 'active'`
re-enabled terminated staff on any edit that omitted status; `role: 'cashier'` was hard-coded on
every update; `permissions: parseSellingUnits(input.permissions)` returned `[]` for a missing
field, and per the rules script's own comment (`configure-pocketbase-rules.mjs:178`) empty means
*full legacy access*. A name-only edit that omitted these fields silently granted full
permissions and reactivated a deactivated account.
Fix: new `cashierPatchPayload` (`server/formatters.js`) only includes a field in the update
payload when the caller actually sent it — `status`, `permissions`, and `void_barcode` are left
untouched if omitted, and `role` is never included at all (this app models a "manager" as a
`role=cashier` account with a `92`-prefixed `void_barcode`, not a distinct role value — see
`isManagerStaffRecord` — so there was never a legitimate reason for this endpoint to touch `role`
in the first place). `PATCH /api/cashiers/:id` (`server/index.js`) now calls this instead of
`cashierFormData`. New test `tests/cashier-patch-payload.test.js` (7 cases, added to
`test:offline`) locks in the omission behavior. `npm run test:offline` (124/124) and `npm run
test:vercel` (3/3) pass.

**S6. MEDIUM** — `server/formatters.js:194` hardcodes fallback password `'cashier123'`, no
forced change on first login.

**S7. MEDIUM** — `DELETE /api/cashiers/:id` (`server/index.js:1660`) has no target-role,
self-delete, or last-admin guard.

**S8. MEDIUM** — CORS accepts any `*.ngrok-free.dev` origin with `credentials: true` whenever
`NODE_ENV !== 'production'`, which the `npm run host` deploy path never sets
(`server/index.js:45-49,97-108`); `isSameRequestOrigin` also trusts unvalidated
`X-Forwarded-Host` (`:60-67`).

**S9. LOW** — `src/cashier-pos/utils/cashierLoginPolicy.js:1-5`
`allowsCashierBarcodeLogin` only rejects the empty string; its name implies a gate that does not
exist, and its test (`tests/cashier-login-barcode.test.js`) passes vacuously.

---

## M — Money correctness

**M1. CRITICAL — Refunds never reach the cloud at all.** No `sale_adjustments` collection and
no `refunded_amount`/`refunded_at` field anywhere in `pocketbase/pb_schema.json` (`sales` fields
end at `updated`, line 824). Sync only flips `sales.status` to `'adjusted'`
(`src/cashier-pos/offline/syncEngine.js:740-743`). Amount, items, reason, approver, timestamp
exist **only** in local Dexie (`saleRepository.js:322`). Wipe a terminal and every refund ever
issued on it is gone; cloud revenue reports have never netted out a single refund.
(Was tracker task 6 / B6 — true severity is higher than "reporting.")

**M2. HIGH — Refund restock under-restocks every multi-unit product. ✅ FIXED (this session,
together with M3).**
Was: `adjustLocalSale` rebuilt `returnedItems` and dropped `conversion`
(`src/cashier-pos/offline/saleRepository.js:267-291`), so `restoreProductStock` hit
`toBaseStockQuantity(qty, undefined)` → defaulted to `1`. Refund one case of 24, get 1 unit back.
The cloud op was the same. The void path was always correct by contrast (it passes stored
`sale.items`), which is why this went unnoticed. (Was tracker B4.)

**M3. HIGH — Refund quantity is unclamped in the cloud op. ✅ FIXED (this session, together with
M2).**
Was: `desktopApi.js` queued the cloud op with raw UI `items` **before** calling `adjustLocalSale`,
and never fed the clamped result back — refund 99 of a qty-2 line and local restocks 2 while cloud
restocks 99. Also two independent Dexie transactions, so a crash between them could lose either
side. (Was tracker B5/B8.)
Fix (both M2 and M3 together, since they're the same root cause — the cloud op and the local
restock used to be built from two different, independently-computed item lists): `returnedItems`
in `adjustLocalSale` now carries `conversion` through from the *stored* sale line
(`saleRepository.js`). The cloud op is now queued *inside* `adjustLocalSale`'s own Dexie
transaction (added `cashierDb.pendingOps` to `transactionTables`), built from the exact same
clamped `entry.items` used for the local restock — not a second, separately-computed item list
from raw UI input. `desktopApi.js`'s `adjustCompletedSale` no longer calls
`queueCashierOperation` itself; it just passes `approverId` through to `adjustLocalSale` and
triggers `syncEngine.schedule(0)` afterward. New tests in `tests/return-disposition.test.js`:
refunding a case (conversion 24) restocks 24 base units; requesting 99 units on a 2-unit line
queues exactly one cloud op clamped to 2, carrying the same conversion. `npm run test:offline`
(126/126) and `npm run test:vercel` (3/3) pass.

**M4. HIGH — `transactionNo` collides every 10 seconds.**
`desktopApi.js:435-444`: `${YYYYMMDD}${charSum(terminalId)%100}${String(Date.now()).slice(-4)}`.
The suffix is epoch-ms mod 10000 — wraps every 10s. Minted at `:1078` outside the Dexie
transaction (which opens later at `saleRepository.js:114`). `completedSales` indexes it
non-uniquely (`db.js:59`) and `sales.transaction_no` has no unique index (`pb_schema.json:650`).
`findExistingCloudSale` (`syncEngine.js:205-221`) matches on `transaction_no + cashier_id` only,
so on retry it can adopt a *different* colliding sale as "already uploaded" and run item/stock
writes against the wrong record (`:761-771`, and the void/adjust path at `:705-711`).
(Was tracker B1.)

**M5. HIGH — Void issued mid-upload is silently lost cloud-side.** `voidLocalSale` deletes the
queued row (`saleRepository.js:228-242`) while `uploadSale` already holds it in memory and
unconditionally deletes/marks-synced after uploading (`syncEngine.js:811-814`) with no status
re-read. The cloud keeps `status: 'completed'`, cloud stock stays deducted, and no void op is
queued because `desktopApi.js:1255` only queues one when `syncStatus === 'synced'`. Stock is
double-counted. (Was tracker B9.)

**M6. HIGH — Cash in/out double-taps double-count the drawer. ✅ FIXED (this session).** New
finding, not in the prior tracker.
Was: `confirmCashFlow` had no busy flag and no early return; the button was never disabled and
Enter re-submitted. Two `cash_movements` rows, `shiftSession.cashOut` incremented twice, two
activity logs — and the admin Audit page derives cash movements from those log lines, so a
₱2,000 cash-out reconciled ₱4,000 short. `recordCashMovement(...).catch(() => {})` also meant a
failed drawer write was silent while the activity log still claimed it happened. Same gap existed
in `confirmVoidTransaction` — a double-invoke double-logged a void as "0 item(s), ₱0.00" because
the cart is cleared before the second invocation reads it.
**Correction to the prior tracker:** checkout itself was already correctly guarded (`Cashier.jsx`
`if (paymentFlow.busy) return`, `disabled={paymentFlow.busy}`) — the "double-tap double-rings a
sale" note in the old deferred list was stale. The real gap was cash flow and void, not checkout.
Fix: added `voidActionLoading` / `cashFlowActionLoading` state (`src/cashier-pos/pages/Cashier.jsx`),
mirroring the pattern already correct on the refund/exchange lookup flow (`lookupActionLoading`).
Both `confirmVoidTransaction` and `confirmCashFlow` now early-return while busy, both buttons are
`disabled` while busy (also disables the barcode/approval input during void so a stray keystroke
can't re-trigger it), and the Enter-key submit paths route through the same guarded functions so
they're covered for free. `recordCashMovement(...).catch(() => {})` was removed — a failed drawer
write now propagates to the existing catch block, which reports the failure instead of silently
proceeding to log a success. No component test harness exists in this repo for `Cashier.jsx`
(verified by bundle-check + full offline/vercel suites, which don't regress). `npm run
test:offline` (126/126) and `npm run test:vercel` (3/3) pass.

---

## T — Sync / request-volume

**T1. Admin sync engine parity.** Cashier has reachability TTL caching (15s success / 8s
failure, `syncEngine.js:26-27,272-286`) and schedule jitter (0–15s one-sided — **correction to
prior tracker text, which said ±15s** — `:31,242,265`); admin has neither
(`admin/offline/syncEngine.js:302-313,295`). The admin "Sync" click builds
`new CashierSyncEngine({ pb })` per click (`admin/services/desktopApi.js:1960`), which also
resets `lastProductRefreshAt` to 0, forcing a full `products.getFullList()` on every click.
Manual-sync backoff wipe confirmed in both apps
(`admin/desktopApi.js:1951-1959`, `cashier/desktopApi.js:1107-1111`). Cashier catalog-refresh
`lastProductRefreshAt = 0` on failure confirmed (`cashier/offline/syncEngine.js:371`), causing
full-catalog retry every tick with no backoff after any failure.
**New in this pass:** admin's activity-log upload queue
(`admin/offline/syncEngine.js:334-336,399-417`) has no `attempts`/`nextAttemptAt` filter at all —
a single permanently-invalid log row means one wasted `create` every tick, forever, with no
backoff. **Also new:** admin's own `pendingOps` failed-reset does not clear `attempts`
(`admin/desktopApi.js:1951`), so an already-exhausted op is re-marked pending and immediately
re-fails on attempt 11 (asymmetric with cashier's queues, which do reset `attempts`).

**T2. Cashier sales-history N+1 + quick-login fan-out.** `groupSaleItemsBySaleId` needs
extracting into `src/utils/saleItemGrouping.js` (mirrors a fix already shipped on the admin
side) — confirmed it does not exist yet. Cashier history still does one request per sale.
`emailVisibility: true` should be set at quick-login enable-time instead of a page-load backfill
loop issuing one `users.update` per user.

**T3. Sale-upload batch rewrite.** `ensureCloudSaleItems` (`syncEngine.js:95-156`) +
`ensureCloudStockDeduction` (`syncEngine.js:158-203`) issue ~8–9 PocketBase requests per line
item, serially, all awaited. The barcode fallback inside `ensureCloudSaleItems` issues a
**whole-catalog `getFullList` inside the per-item loop** (`:121`) — confirmed, not previously
called out this precisely. `pb.createBatch()` is used nowhere in the repo (grep: 0 hits). No
`lineId` exists anywhere (grep: 0 hits) — everything downstream keys on `productId` only, so two
cart lines of the same product at different units/prices collapse into one key. The
`Math.max(baseQuantityToDeduct, syncedQty)` fudge is at `:171` and is worse than previously
described: `syncedQty` sums `quantity_sold` (selling units) while `baseQuantityToDeduct` is base
units — the `Math.max` compares two different units and its result is written straight into
`stock_movements.quantity` (`:190`). Same ordering fix needed in admin's scan/stock-out/adjust
path and cashier's void/refund path. (Was tracker B2/B3.)

---

## H — Hygiene / non-POS

**H1. HIGH (repo weight)** — `db_json_export/` is 176 MB across 50 tracked files
(`DocumentItem.json` 87 MB, `Document.json` 65 MB, `Payment.json` 23 MB), raw legacy
transaction/customer records, permanent in git history. Only consumer is
`scripts/import-legacy-json.mjs:10`, a migration already executed (results in
`migration_reports/`).

**H2. HIGH (process)** — `.github/workflows/` contains only `release.yml` (tag-triggered Tauri
build). **No CI runs tests or lint at all.** `test:offline` in `package.json` names 29 files
explicitly while `tests/` holds 39 test files — 9 exist but are executed by no npm script:
`payment-flow.test.js`, `cash-sales.test.js`, `shift-close-receipt.test.js`,
`cashier-transaction-restore.test.js`, `cashier-login-barcode.test.js`,
`audit-log-parsing.test.js`, `product-pricing.test.js`, `receipt-pdf.test.js`,
`developer-mode.test.js`.

**H3. MEDIUM** — `docx` is a production dependency (`package.json`) with zero runtime imports;
only the unwired `scripts/generate_*.{js,cjs,py}` doc generators use it, and none of those are
wired to any npm script. Every other dependency is genuinely used
(`@tauri-apps/plugin-updater` shows 0 static imports but is dynamically imported at
`src/components/DesktopUpdater.jsx:22` — keep it, it's a false positive).

**H4. LOW** — Root is cluttered with process/merge docs (`MERGE_COMPLETION_SUMMARY.md`,
`MERGE_EXECUTION_GUIDE.md`, `RESTRUCTURING_NOTES.md`, `QUICK_START_CHECKLIST.md`,
`SETUP_INSTRUCTIONS.txt`) and a debug harness (`scripts/debug-pb-login.mjs`) shipped alongside
production scripts.

**H5. LOW** — See S9 above (dead policy stub) — cross-referenced here as hygiene too.

---

## Deferred (unchanged from prior audit — still out of scope for the active remediation pass)

- S4, S6, S7, S8 (support-relay hardening, default-password policy, delete guard, CORS
  tightening) — real, tracked above, not blocking the security-first pass which targets
  S1/S2/S3/S5 specifically (the approval-barcode/credential/auth-bypass/privilege-escalation
  cluster).
- H1/H2/H3/H4 hygiene cleanup — tracked, scheduled after money-correctness.

## How to resume

Work order for the active remediation: **S1 → S2 → S3 → S5** (security), then
**M2 → M3 → M6 → M5 → M4 → M1** (money correctness, cheapest/most self-contained first), then
**T1 → T2 → T3** (sync/request-volume — T3 lands after M4 since stable transaction numbers and
per-line `lineId` are what make batched writes keyable correctly), then **H1 → H2 → H3 → H4**.
Full rationale and step-by-step detail for each item lives in
`C:\Users\ASUS\.claude\plans\run-another-audit-check-golden-wave.md`. Each fix should land with a
test written first; `npm run test:offline` must stay green throughout (114/114 as of this
register).
