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
- **Manager barcode approval works offline** via a locally cached salted one-way hash (see S1's
  "Decision reversed" entry) — this supersedes S1's original online-only choice; do not revert to
  online-only without the client. Email/password manager approval remains online-only.

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

**Regression discovered and fixed (follow-up session): the server-mediated fix above broke
desktop barcode login in this client's actual production topology.** The fix assumed a reachable,
non-Vercel-gated Express server for `POST /api/cashier/auth/barcode` and
`POST /api/cashier/authorize-void`. This client's desktop (Tauri) app has no such server — per
`VERCEL_DEPLOYMENT.md`, the Vercel deployment is documented and coded as admin-only
(`server/index.js`'s `/api/cashier` gate 404s every cashier route whenever `process.env.VERCEL` is
set, which Vercel sets unconditionally on every deployment), and the desktop app otherwise talks
directly to PocketBase (PocketHost) for everything else. Email/password login kept working because
it authenticates against PocketBase directly and never touches the Express API at all; barcode
login broke because it now depends on a server that this deployment doesn't have running anywhere
reachable, surfacing as `"Cashier services are not available in the remote admin portal."`
Reverting the server-mediated verify was not an option — the underlying PocketBase collection
rules are already tightened to admin-only, so a cashier's own token can no longer read
`authorization_barcodes`/`users` directly regardless of client code; some server-side verifier is
required.
Fix: `server/index.js`'s blanket `/api/cashier` 404 gate now allows exactly three paths through
even in admin-only mode — `/auth/barcode`, `/authorize-void`, `/quick-login-accounts` — confirmed
via `grep` to be the *only* `/cashier/*` endpoints the desktop client calls through the Express
API (`cashierApiRequest` call sites in `src/cashier-pos/services/desktopApi.js`). Every other
cashier route (ring sales, void, sync, history) remains blocked on Vercel, unchanged — those
correctly stay desktop-only/offline-first per the documented architecture. This reuses
infrastructure that's already deployed and always-on (the existing Vercel project); no new
service, no client rebuild needed beyond redeploying the updated `server/index.js`.
New assertions added to `tests/admin-vercel-boundary.test.js`: the three allowlisted paths are
reachable (non-404) on a simulated Vercel deployment, while a non-allowlisted cashier path
(`/cashier/sales`) still correctly 404s. `npm run test:offline` (203/203) and
`npm run test:vercel` (6/6) pass; both `npm run build` and `npm run build:vercel` clean.
**Action required from the client: redeploy the Vercel project** with this change for barcode
login to work again — the fix is in the code, not yet live until the Vercel deployment is rebuilt.
(Resolved: the client's local `main` was 19 commits ahead of `origin/main` — none of this
session's or the prior session's work had ever been pushed to GitHub, so no redeploy could have
picked it up. Pushed; confirmed `origin/main` matches local `main`.)

**Decision reversed (follow-up session, client request): manager approval is no longer
online-only.** The original S1 fix deliberately chose online-only approval over caching a salted
hash locally (see "Fix" above), because relying on connectivity was judged an acceptable
trade-off at the time. The client has since determined it isn't — their store can't rely on
internet always being available — and asked for the offline-capable option that was originally
declined.
Built: `GET /api/cashier/manager-approval-hashes` (`server/index.js`, added to the same Vercel
admin-only-gate exemption list as the other three cashier auth endpoints, same reasoning) hands out
a freshly minted, salted, one-way PBKDF2 hash (100,000 iterations, SHA-256, via the standard Web
Crypto API) of every currently active manager barcode/authorization code — covering both
`users.void_barcode` (`role="manager"`/`"admin"`, or `role="cashier"` with a `92`-prefixed barcode)
and the standalone `authorization_barcodes` collection. The real barcode is never cached on the
terminal in reversible form and nothing is persisted server-side either — a fresh salt is minted on
every call, so there is no stored hash to leak. New shared `src/utils/managerApprovalHash.js`
(`deriveApprovalHash`, `matchesApprovalHash`, `findApprovalHashMatch`) runs identically on both
server and client (same Web Crypto API, so there is no risk of a client/server algorithm mismatch
silently breaking matches). The client (`authorizeManagerApproval`,
`src/cashier-pos/services/desktopApi.js`) tries the existing online verify first when reachable;
on a network-shaped failure (or when already known offline), it falls back to hashing the
scanned/typed barcode against the cached entries. The cache refreshes on every login and every
15 minutes while online (`startManagerApprovalHashesRefreshLoop`), and best-effort after every
successful online approval.
**Scope, deliberately limited to barcode approval.** Email/password manager approval remains
online-only — caching a verifiable hash of a manager's actual login password offline is a
materially different risk than a low-entropy barcode (a password is also the credential used to
access far more than just approvals) and was not part of what was asked for. A manager can still
use their barcode offline; email/password approval will prompt to reconnect or use a barcode
instead.
**Residual risk, inherent to any offline-capable auth, not eliminated:** if a manager is
deactivated or their barcode changed while a terminal is offline, that terminal keeps accepting the
old cached hash until it next successfully reconnects and refreshes (up to 15 minutes after
reconnecting, or immediately on next login). This is the same trade-off the pre-existing offline
cashier *login* fallback already has — not a new category of risk, just extended to approval too,
per the client's explicit choice.
New `tests/manager-approval-hash.test.js` (10 cases): salt uniqueness, hash determinism, hash
sensitivity to both value and salt, correct match/rejection, malformed-input handling,
multi-candidate matching. New `tests/admin-vercel-boundary.test.js` case confirming the hash
endpoint is reachable (not 404) on the Vercel admin-only gate. The wiring inside
`authorizeManagerApproval` itself has no automated test coverage — `desktopApi.js` references
`import.meta.env` at module scope and can't be imported in a plain Node test (same limitation
already documented for `Cashier.jsx` under M6); verified instead via `esbuild` bundle-check plus
the full suite, consistent with how this codebase already handles this class of file.
`npm run test:offline` (222/222) and `npm run test:vercel` (7/7) pass; `npm run build`,
`npm run build:vercel`, and `npm run build:cashier` all clean.

**Second regression found and fixed (follow-up session): barcode login never actually applied
the server-issued session token, causing an intermittent "the cloud returned zero products"
failure.** Reported by the client immediately after voiding a completed sale. Traced the
connection: voiding a synced sale queues a cloud undo operation and immediately fires a sync tick
(`CashierSyncEngine.syncNow`, `src/cashier-pos/offline/syncEngine.js`), which specifically forces a
full product catalog refresh whenever a void/adjustment is queued (`operationNeedsCatalog`) — that
refresh is what was failing. The sync engine's own pre-check (`this.pb.authStore.isValid`) reported
the session as valid, ruling out an outright missing token — so PocketBase was very likely silently
filtering out every row via its `listRule` (a per-record filter, not a hard reject: an
insufficiently-authenticated request gets a 200 with zero results, not an error) rather than
genuinely returning no products.
Root cause: `loginWithBarcode` (`src/cashier-pos/services/desktopApi.js`) calls the S1/S3
server-mediated verify (`POST /api/cashier/auth/barcode`), which mints and returns a real 12-hour
PocketBase session token (`usersCollection.impersonate(...)`, `server/index.js`) *specifically so
the terminal can authenticate its own calls* — but the client discarded it. It only called
`restoreCashierSyncAuth`, which reuses whatever token was cached from a **previous** login. For a
cashier who logs in mostly (or only) by barcode, that cached credential can go stale enough that
`authStore.isValid`'s local expiry check still passes while PocketBase itself no longer honors it
for `listRule`-gated collections — a client/server disagreement about session validity, not a
missing token. Confirmed by the client's own report: barcode login, retry/re-login "fixes" it
(consistent with a stale-credential theory — a retry happens to establish a workable token by
chance, not because anything was actually corrected), which matches this exactly.
Fix: `loginWithBarcode` now applies the server's returned token directly to the terminal's
PocketBase session (`activeRuntime.pb.authStore.save(...)`) and persists it via the same
`cacheCashierSyncAuth` password login already uses, falling back to `restoreCashierSyncAuth` only
when no server token was available (e.g., an offline barcode login served from the local cache).
**Not independently unit-tested** — same `import.meta.env` limitation as the manager-approval-hash
wiring above (this codebase's established, documented gap for this class of file); verified via
`esbuild` bundle-check and the full regression suite (no change in pass count, confirming no
existing behavior broke). `npm run test:offline` (224/224 — 2 more than above, from the unrelated
cash-sales fix landing alongside this one) and `npm run build:cashier` clean.
**Ask the client to confirm** after rebuilding the Tauri app: log in by barcode, then void a synced
sale, and check whether the catalog-refresh warning still appears.

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

**S4. HIGH — `/api/support/tickets` is an open mail relay. ✅ FIXED (follow-up session).**
Was: two separate implementations of this route exist. `server/index.js:176` (the Express route,
live on the desktop/local-host deployment) already had origin-restricted CORS via the app's global
`cors()` middleware and an image-only file filter, but no rate limit. `api/support/tickets.js`
(a standalone Vercel serverless function) is the one **actually live in production on Vercel** —
Vercel's filesystem routing matches a literal `api/support/tickets.js` file before the
catch-all `/api/:path* → /api` rewrite in `vercel.json` ever applies, so this standalone file, not
the Express app, handles every request to this path on the deployed admin-web target. It had
`Access-Control-Allow-Origin: '*'` (line 17, old), no rate limit, and no attachment type filter —
an unauthenticated (by design, since support has to work for a cashier who can't log in) endpoint
that sends mail through the business's own SMTP credential, reachable by anyone who found the URL,
browser or script.
Fix: `api/support/tickets.js` now validates the request `Origin` against `CLIENT_ORIGIN` plus the
same `desktopOrigins` set used in `server/index.js` (the Tauri desktop app calls this Vercel URL
cross-origin from a fixed `tauri://` origin; the deployed web app's own same-origin calls aren't
gated by CORS in the first place). Origin restriction alone would not be sufficient on its own — a
non-browser caller can send any `Origin` header it likes, or none — so the primary control is a new
per-IP sliding-window rate limiter (same design as `server/index.js`'s `checkRateLimit`, with the
added caveat that a serverless deployment may run several concurrent instances each with their own
copy of the in-memory counter, so this is a soft per-instance bound, not a hard global cap — still
a meaningful deterrent versus none). Also added the same image-only (`jpeg`/`png`/`webp`) attachment
filter `server/index.js`'s version already had — the frontend (`SupportContactModal.jsx`) already
restricts its file picker to `accept="image/*"`, so this is pure hardening with no legitimate use
case affected. `server/index.js`'s Express route got the matching rate limiter for
defense-in-depth/consistency, reusing the existing `checkRateLimit`.
**Deliberately not added:** a captcha. That requires picking and integrating a third-party service
(reCAPTCHA/hCaptcha) plus a frontend change — a real, separately-scoped decision, not something to
bundle into a security patch without the client choosing a provider.
New `tests/support-tickets-security.test.js` (5 cases, driving the actual standalone handler over a
real HTTP server the way Vercel invokes it): a disallowed origin gets no `Access-Control-Allow-
Origin` header, the desktop origin is allowed, a configured `CLIENT_ORIGIN` is allowed, a
non-image attachment is rejected with a clear message, and repeated requests from the same
connection eventually 429. `npm run test:offline` (203/203) and `npm run test:vercel` (3/3) pass;
`npm run build` and `npm run build:vercel` both clean.

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

**Gap found and fixed (follow-up session): the same vulnerability was still fully live in the
desktop (Tauri) admin app — the client's primary app — via a completely separate code path.**
The S5 fix above only covers `server/index.js`'s Express PATCH route, which the web (Vercel) admin
uses. The desktop admin app never calls that route at all: `src/admin-page/services/
desktopApi.js`'s `updateCashier` writes staff edits straight to PocketBase
(`pb.collection('users').update(...)`), reusing `cashierPayload` — the same create-time builder
that defaults `status` to `'active'`, hard-codes `role`, and defaults `permissions` to `[]` — for
every update (online, offline-queued, and the password-change branch alike). A name-only edit to
a cashier from the Tauri app would have silently reactivated a terminated account and reset
permissions to full legacy access, identical to the original S5 bug, just in the code path the
client actually uses day to day.
Fix: extracted a new `cashierUpdatePayload` (`src/admin-page/utils/cashierUpdatePayload.js`,
a pure function so it's testable without a Vite/`import.meta.env` shim — `desktopApi.js` can't be
imported directly in a plain Node test) mirroring `cashierPatchPayload`'s omit-when-absent
semantics exactly. Wired into `updateCashier`'s three branches (online, offline-queued, and the
password-change branch's own body builder via `cashierUpdateBody`). The offline-queued branch also
had a related bug fixed as a side effect: it always sent `void_barcode` (defaulting to `''` when
not part of the edit), which meant editing a cashier without touching their barcode field could
wipe it; the new payload omits it when not part of the edit, so `local.cashierBarcode` correctly
falls back to the existing cached value instead.
New `tests/cashier-update-payload.test.js` (9 cases, mirroring `cashier-patch-payload.test.js`'s
coverage). `npm run test:offline` (212/212) and `npm run test:vercel` (6/6) pass; `npm run build`,
`npm run build:vercel`, and `npm run build:cashier` (the actual Tauri build target) all clean.

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

**M1. CRITICAL — Refunds never reach the cloud at all. 🔶 PARTIALLY FIXED (this session) — the
data now reaches the cloud; reports do not read it yet.**
Was: no `sale_adjustments` collection and no `refunded_amount`/`refunded_at` field anywhere in
`pocketbase/pb_schema.json`. Sync only flipped `sales.status` to `'adjusted'`. Amount, items,
reason, approver, timestamp existed only in local Dexie. Wipe a terminal and every refund ever
issued on it is gone; cloud revenue reports never netted out a single refund. (Was tracker task 6
/ B6 — true severity is higher than "reporting.")
Done:
- New `scripts/add-refund-reporting-schema.mjs` (additive-only migration): `sales.refunded_amount`,
  `sales.refunded_units`, `sales.refunded_at`, and a new `sale_adjustments` collection
  (`sale_id`, `adjustment_id`, `type`, `amount`, `items`, `reason`, `note`, `approver_id`,
  `cashier_id`, `restock`, `created_at`). `total_amount` is never mutated by any of this — see the
  file's header comment for the reasoning. **Not yet run against production** — per the client's
  choice this session, schema migrations are applied by them directly (`npm run
  pb:migrate:refund-schema` once ready); this script was written and code-reviewed but not
  executed against a live PocketBase from here.
- `src/cashier-pos/offline/syncEngine.js`'s `adjustCompletedSale` op handler now creates a
  `sale_adjustments` record (idempotency-anchored on `adjustment_id`, the same UUID the terminal
  already generates locally at refund time) and additively increments
  `sales.refunded_amount`/`refunded_units`/`refunded_at` — both writes tolerate a 404/400 from an
  un-migrated PocketBase without failing the whole op, so this lands safely whether or not the
  schema migration has run yet.
- New `src/utils/saleTotals.js` — pure `netSaleAmount`/`netSaleUnits` helpers. A legacy row with no
  refunded fields returns its full original total/units, completely unchanged.
- Tests: `tests/sale-totals.test.js` (6 cases — legacy row, full/partial/over refund, snake_case
  vs camelCase, missing items array) and `tests/sale-adjustment-cloud-sync.test.js` (3 cases — new
  refund creates the record and increments additively; a retry of the same `adjustment_id` does
  not double-count; a second different refund adds to, not replaces, the running total).
**✅ Now fully FIXED (follow-up session).** `netSaleAmount` is wired into every aggregate revenue
site in `server/index.js`: `/api/dashboard`'s daily/yesterday/monthly/last-month/total revenue,
payment-method breakdown, hourly series, the daily/weekly/monthly/yearly trend series, and
`recentTransactions`; plus `getSalesByCashier` (the per-cashier sales KPI shown on staff
management). Two call sites were deliberately left reading raw `sale.total_amount` — `
receiptRecordFromSale` and `gcashPaymentFromSale` — because those represent a specific historical
transaction record (a receipt reprint, a payment-ledger line), not an aggregate report; showing a
netted figure there would misrepresent what was actually charged at time of sale. The refund/void
status is already visible on those records separately (`status: 'Adjusted'`).
Units-sold/FSN netting required more than swapping in `netSaleUnits` (which nets at the whole-sale
level): `buildSalesMetrics` (`server/index.js`) and the dashboard's per-product breakdown both
aggregate `sale_items.quantity_sold` per **product**, so a sale-level refunded-units figure can't
be attributed to the right product when a sale has multiple line items. Fixed by joining
`sale_adjustments.items` (which carries the same `{productId, quantity}` shape queued locally at
refund time) against `sale_items` at the `(sale_id, product_id)` grouping level — new
`refundedUnitsBySaleAndProduct()` and `saleItemsBySaleAndProduct()` helpers (`server/index.js`),
used by both `buildSalesMetrics` (now takes an `adjustments` parameter) and `/api/dashboard`'s
per-product unit breakdown (`topProducts`, `selectedUnitsSold`, `topCategories`). A sale fully
refunded no longer counts toward a product's `lastSoldAt` for FSN classification. Both routes
fetch `sale_adjustments` with `.catch(() => [])` so an un-migrated PocketBase instance degrades to
un-netted figures instead of failing the whole dashboard/FSN report. New
`tests/dashboard-refund-netting.test.js` (8 cases): sum-by-key correctness, malformed-entry
handling, legacy row unchanged, partial refund nets correctly, over-refund clamps at zero (never
negative), a fully refunded sale drops out of `lastSoldAt`, refunds don't cross-contaminate other
products or other sales of the same product, voided sales stay excluded regardless of refund data.
`npm run test:offline` (189/189) and `npm run test:vercel` (3/3) pass; `npm run build` clean.

**⚠️ Gap found, NOT yet fixed: the netting above only reaches the web (Vercel) admin dashboard —
the desktop (Tauri) admin app, the client's primary app, computes its own dashboard/FSN figures
independently and does not net refunds at all.**
`src/admin-page/services/desktopApi.js`'s `buildDashboardFromRecords` (~line 989) and
`buildFsnMetrics` (~line 1153) are a **separate, parallel implementation** — not a call into the
Express `/api/dashboard`/`/api/inventory/fsn` routes fixed above — that sums raw
`total_amount`/`quantity_sold` with no refund awareness, merging local (not-yet-synced) sales with
cloud PocketBase records for offline-first support. This is real, scoped follow-up work, not
something to retrofit blind: it needs the same `sale_adjustments` join as the server-side fix, but
applied against a dataset that already merges local-Dexie and cloud sales with its own
override/dedup logic (`fsnInventory()`/`dashboard()`, ~lines 1811-1926) — a legacy local sale's
refund state needs checking too, which the server-side fix never had to consider.
**Until this lands, refund data recorded via M1's cloud write is not reflected in the dashboard the
client actually looks at day to day** (only in the secondary Vercel web admin, if used).
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

**M4. HIGH — `transactionNo` collides every 10 seconds. ✅ FIXED (desktop cashier, this
session).**
Was: `desktopApi.js` generated `${YYYYMMDD}${charSum(terminalId)%100}${String(Date.now()).slice(-4)}`
— the suffix is epoch-ms mod 10000, wrapping every 10s, minted outside any transaction.
`findExistingCloudSale` matched on `transaction_no + cashier_id` only, so on retry it could adopt
a *different* colliding sale as "already uploaded" and run item/stock writes against the wrong
record. (Was tracker B1.)
Fix: new `src/cashier-pos/offline/transactionNumber.js` — all-numeric, `YYYYMMDD` (8) + a
deterministic per-terminal ordinal (6) + a persistent per-terminal-per-day counter (5) = 19
digits. `mintTransactionNumber()` claims the counter atomically and is only ever called from
*inside* `finalizeSaleLocally`'s own Dexie transaction (`cashierDb.settings` added to its table
list) — the caller-supplied `sale.transactionNo` is now ignored entirely for the number that
actually gets recorded; `nextTransactionNumber()` (the UI preview shown before checkout) uses a
non-consuming `peekNextTransactionNumber()` instead, which may legitimately differ from the final
number if another open tab finalizes first — that's a display estimate, not a reservation, and the
UI already prefers the authoritative returned value over the preview (`Cashier.jsx`). Verified via
grep: no receipt/CSV-export/admin consumer assumes a fixed digit count, and PocketBase's
`sales.transaction_no` field has no max-length constraint (just `pattern: "^[0-9]+$"`), so the new
19-digit format is accepted as-is. `findExistingCloudSale` now also requires the matched record's
`total_amount` and a same-day timestamp to corroborate before adopting it on retry.
**Deliberately NOT done:** promoting `completedSales.transactionNo` to a Dexie unique index. A
hard unique constraint added via a Dexie version-bump migration can throw `ConstraintError` and
break the upgrade on any terminal that already has duplicate values from the old generator —
verifying that's safe requires either real production data or the client's input on how to handle
existing duplicates first. Left as a distinct, separately-scoped follow-up.
**New finding, not yet fixed:** the *web* (server-backed) cashier's `nextTransactionNumber()`
(`server/index.js`) has the same class of bug via a different mechanism — it reads all of today's
sales, computes `max(sequence)+1`, and returns it with no atomic claim, so two concurrent web
checkouts can compute and use the identical next number (classic read-then-write race). Not fixed
in this pass; the desktop terminal is this codebase's primary offline-first architecture and was
the audit's explicit citation, but this is real and should be scoped alongside it.
New `tests/transaction-number.test.js` (all-numeric, no same-terminal collision even minted in the
same millisecond, correct day-boundary reset, peek doesn't consume) and
`tests/cashier-sale-retry-corroboration.test.js` (an uncorroborated same-`transaction_no` match is
rejected; a corroborated one is adopted). `npm run test:offline` (134/134) and `npm run
test:vercel` (3/3) pass.

**M5. HIGH — Void issued mid-upload is silently lost cloud-side. ✅ FIXED (this session).**
Was: `voidLocalSale` deleted the queued row while `uploadSale` already held it in memory and
unconditionally deleted/marked-synced after uploading, with no status re-read. The cloud kept
`status: 'completed'`, cloud stock stayed deducted, and no void op was queued because
`desktopApi.js` only queued one when `syncStatus === 'synced'`. Stock was double-counted. (Was
tracker B9.)
Fix: `voidLocalSale` (`saleRepository.js`) now tombstones the `pendingSales` row (sets
`voidPending: true` plus reason/approver/timestamp) instead of deleting it outright, whenever the
sale is still queued for upload — a bare delete gave an in-flight `uploadSale` call (which already
holds its own in-memory copy, read before the void's transaction started) no way to learn a void
had just happened. `uploadSale` (`syncEngine.js`) now checks this twice: on entry, a sale that was
already tombstoned before this tick started skips the cloud entirely (nothing was ever created,
nothing to undo); and again immediately before its final "mark synced" write, re-reading the
*current* Dexie row rather than trusting the in-memory copy — if tombstoned by then, it queues a
`voidCompletedSale` cloud op (the cloud sale this exact call just created still needs undoing)
instead of marking the sale synced. New `tests/cashier-void-tombstone.test.js` covers both paths
directly against `CashierSyncEngine.uploadSale`, including simulating the race by mutating the
Dexie row from inside a fake `sales.create` call. Also updated
`tests/offline-first-under-rate-limit.test.js`, whose old assertion (`pendingSales.count() === 0`
after void) predated tombstoning and is now the expected `1` (tombstoned, not deleted) until a
sync tick reconciles it. `npm run test:offline` (128/128) and `npm run test:vercel` (3/3) pass.

**M7. MEDIUM — A stray open transaction tab silently blocks adding an in-stock product, with no
indication why. ✅ FIXED (diagnostic; underlying reservation design intentionally unchanged).**
New finding, reported by the client, not in the prior tracker.
Was: `openInitialQuantityPrompt` (`src/cashier-pos/pages/Cashier.jsx:2372-2379`) blocks add-to-cart
with a plain "out of stock" message whenever `getAvailableStockUnits` returns 0 — but that figure
is real stock minus a client-side reservation (`getReservedBaseQuantity`, `Cashier.jsx:730-744`)
that subtracts whatever quantity of the same product sits in the cart of *any other open
transaction tab* on that terminal (the cashier UI supports multiple simultaneous held-sale tabs,
`handleNewTransaction`, `Cashier.jsx:3019-3028`). That reservation has three gaps: (1) no expiry —
a tab created and then forgotten reserves its quantity for the rest of the shift
(`restoreCashierTransactions`, `src/cashier-pos/utils/transactionRestore.js`, has no time-based
cleanup); (2) no cap on how many tabs can exist; (3) no visibility — the error message didn't say
the block was caused by another tab, and the product tile the cashier is looking at still shows the
real, unreserved `product.qty`, so the screen says "in stock" while add-to-cart refuses it. Only
cleared by a proper end-of-shift close (`clearCashierTransactions`, `:1309`) or a fresh login with
no open shift (`:1745`), so it can persist a full workday.
Fix: the reservation math is extracted into a pure, testable helper —
`reservedQuantityDetail(transactions, productId, options)`
(`src/cashier-pos/utils/cartReservation.js`) — with no behavior change (same aggregation
`getReservedBaseQuantity` did inline before). Both add-to-cart block messages
(`openInitialQuantityPrompt`'s "out of stock" notification and `commitProductToCart`'s "Only N
available" error) now call a new `describeStockReservation(product, unit)` that appends which tab
is holding the reservation and how much, e.g. "3 pieces held in an open transaction (Tab 2) --
close or complete it to free that stock." This lets a cashier self-diagnose and close the stray tab
immediately instead of assuming inventory is wrong.
**Deliberately not changed:** the reservation behavior itself (no expiry, no tab cap). Auto-expiring
or capping tabs is a business-judgment call (what idle threshold is safe without risking a
legitimate held sale getting silently dropped?) that needs the client's input, not something to
guess at. The diagnostic fix directly resolves the reported symptom (confusion about why an
in-stock item won't add) without touching the underlying multi-tab reservation design, which exists
specifically to prevent overselling across simultaneously held sales.
New `tests/cart-reservation.test.js` (9 cases): multi-tab summation, unit-conversion, completed/
voided exclusion, `excludedTransactionId`/`excludedCartItemId` behavior, cross-product isolation,
tab-name capture for messaging, malformed-input handling. `npm run test:offline` (198/198) and
`npm run test:vercel` (3/3) pass; `npm run build` clean.

**M8. HIGH — Voiding or refunding a completed sale never updates the running Cash Sales figure.
✅ FIXED (follow-up session).** Reported by the client: voided a ₱368 sale, Cash Sales kept showing
₱368.
Was: a completed sale is tracked in two places in `Cashier.jsx` — the live `transactions` tabs
array, and a separately persisted `retainedCompletedSales` list that keeps a sale counting toward
Cash Sales even after its tab closes (`getCashSalesAmountFromSources`,
`src/cashier-pos/utils/cashSales.js`). Both `handleConfirmCompletedVoid` and
`handleLookupApprovalAction` (the Receipt Lookup void/refund/exchange flow) only updated
`transactions` when a sale was voided/adjusted — `retainedCompletedSales` kept the stale
`status: 'completed'` entry forever. `getCashSalesAmountFromSources`'s de-dup checks
`retainedSales` before `currentSales`, so the stale "completed" copy there always won over the
correctly updated "voided" copy, and Cash Sales never dropped.
Fix: new `syncRetainedSaleStatus(saleId, updates)` helper (`Cashier.jsx`) keeps
`retainedCompletedSales` in sync with whatever change was just made to `transactions`; wired into
both void/refund/exchange call sites. New `tests/cash-sales.test.js` cases reproduce the exact
stale-vs-fresh de-dup conflict and confirm the total correctly drops to zero once both sources
agree. `npm run test:offline` (224/224) and `npm run build:cashier` clean.

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

**T1. Admin sync engine parity. ✅ FIXED (this session).**
Was: cashier had reachability TTL caching (15s success / 8s failure) and schedule jitter
(0–15s one-sided — correction to the prior tracker text, which said ±15s); admin had neither. The
admin "Sync" click built `new CashierSyncEngine({ pb })` per click, which also reset
`lastProductRefreshAt` to 0, forcing a full `products.getFullList()` on every click. Manual-sync
backoff wipe (resetting `attempts` to 0) confirmed in both apps, plus a third site: cashier's
post-*login* auto-retry (`retryPendingCashierSync`) did the same thing on every single login, not
just an explicit sync click. Cashier catalog-refresh `lastProductRefreshAt = 0` on failure caused
full-catalog retry every tick with no backoff. Admin's activity-log upload queue had no
`attempts`/`nextAttemptAt` filter at all — a permanently-invalid log row meant one wasted `create`
every tick, forever.
Fix:
- `AdminSyncEngine` (`src/admin-page/offline/syncEngine.js`) now has the same reachability cache
  and schedule jitter as the cashier engine (same constants, same reset-on-`online` behavior).
- The admin Sync click and the admin runtime's own startup now share one `CashierSyncEngine`
  singleton (`cashierQueueSyncEngine`, started once in `adminRuntime`, alongside the existing
  `syncEngine` singleton) instead of constructing and discarding one per click.
- New shared `src/utils/pendingQueueRetry.js` (`forceRetryNow`) replaces every manual-retry call
  site in both apps (admin's `syncNow`, cashier's `syncNow`, and cashier's
  `retryPendingCashierSync`): it makes eligible rows retry now by resetting `status` and clearing
  `nextAttemptAt` **only** when a row's next attempt is genuinely more than 60s out — `attempts`
  is never touched, anywhere.
- Cashier catalog refresh now applies capped exponential backoff (`retryDelay`, same helper
  already used for op retries, capped at the same 5-minute ceiling as the normal refresh interval)
  after a failure instead of resetting to an immediate-retry-forever state.
- Admin's activity-log queue now filters on `nextAttemptAt` the same way `pendingOps` does, and
  applies the same capped backoff on failure — but is deliberately never dead-lettered (unlike
  `pendingOps`'s `MAX_ATTEMPTS` cutoff): a silently-dropped audit-trail entry is worse than one
  that keeps retrying forever on a capped backoff.
New tests: `tests/pending-queue-retry.test.js` (3 cases) and
`tests/admin-sync-reachability-cache.test.js` (3 cases, mirroring the existing cashier coverage).
`npm run test:offline` (149/149) and `npm run test:vercel` (3/3) pass.

**T2. Cashier sales-history N+1 + quick-login fan-out. ✅ FIXED (this session).**
Was: cashier's `cloudSalesHistory` fetched sale items with one bounded-concurrency request per
sale (still N requests total for N sales), while the admin side already had a fixed pattern (one
bulk `sale_items.getFullList()` + in-memory grouping). `ensureQuickLoginEmailVisibility` issued
one `users.update` per staff record with `quick_login_enabled=true && !emailVisibility`, on
**every** staff-list page load (3 call sites) — redundant, since `emailVisibility: true` is
already set at quick-login enable-time (`setQuickLoginEnabled`/`updateCashier`).
Fix: extracted `groupSaleItemsBySaleId` into shared `src/utils/saleItemGrouping.js`; admin's
`fetchReceiptRecords` now imports it instead of keeping its own copy, and cashier's
`cloudSalesHistory` (`src/cashier-pos/services/desktopApi.js`) was rewritten to do the same
bulk-fetch-then-group pattern instead of one request per sale — dropped the now-unused
`mapWithConcurrency`/`SALE_ITEMS_FETCH_CONCURRENCY` bounded-fan-out helper entirely.
`ensureQuickLoginEmailVisibility` and all 3 call sites removed — enable-time already covers every
account going forward; a legacy account enabled before that fix landed is a narrow, one-time
edge case (toggling quick-login off/on fixes it), not worth N requests on every page load
indefinitely. New `tests/sale-item-grouping.test.js` (4 cases: grouping, relation-array unwrap,
camelCase fallback, missing reference). `npm run test:offline` (153/153) and `npm run test:vercel`
(3/3) pass.

**T3. Sale-upload batch rewrite. 🔶 PARTIALLY FIXED (this session) — the correctness bug (B3) is
fixed; the request-volume optimization (`pb.createBatch()`) is not.**
Was: `ensureCloudSaleItems` + `ensureCloudStockDeduction` issue ~8–9 PocketBase requests per line
item, serially, all awaited, with a whole-catalog `getFullList` inside the per-item barcode
fallback loop. `pb.createBatch()` is used nowhere in the repo. No `lineId` existed anywhere —
everything downstream keyed on `productId` only, so two cart lines of the same product at
different units/prices (e.g. one sold as a case, one sold loose) collapsed into one stock-movement
reference key: creating the movement for line 1 made the dedup lookup report "already handled" for
line 2, silently skipping its deduction (or its restock, in the void/refund path — same bug,
same fix). The `Math.max(baseQuantityToDeduct, syncedQty)` fudge compared two different units
(selling-unit `quantity_sold` vs. base-unit `baseQuantityToDeduct`) and wrote the larger,
nonsensical result straight into `stock_movements.quantity`. (Was tracker B2/B3.)
Done — the correctness fix (B3):
- New `scripts/add-sale-item-line-id.mjs` (additive-only migration): `sale_items.line_id`. **Not
  yet run against production** — same as M1's migration, per the client's choice this session.
- `finalizeSaleLocally` (`saleRepository.js`) now mints a stable `lineId` per cart line.
- `ensureCloudSaleItems`/`ensureCloudStockDeduction` and the void/refund restock path
  (`syncEngine.js`) now key their stock-movement dedup reference on `lineId` (falling back to
  `productId` only for sales queued before this field existed, a narrow transition window). The
  `Math.max` fudge is now applied only in that same legacy-fallback branch — any sale with a
  `lineId` uses the correct, unambiguous `baseQuantityToDeduct` directly.
- `adjustLocalSale`'s `returnedItems` now also carries `lineId` through from the stored line, so
  the refund/exchange cloud op inherits the same per-line correctness.
- New `tests/sale-line-id-dual-deduction.test.js`: two cart lines of the same product (one a case
  of 24, one loose) both get deducted — 26 base units total, not 24 or 2 alone — and produce two
  distinct stock-movement references.
- Investigated and ruled out: admin's scan/stock-out/adjust path does **not** need this fix —
  each of those ops already operates on exactly one product per op (`op.id` is already a unique,
  unambiguous reference), so there is no multi-line-per-op collision possible there. The "same fix
  needed" note in the original finding did not hold up under closer reading of that code path.
**Not done — the request-volume optimization:** the `pb.createBatch()` rewrite itself (~8–9
requests per line item down to one transactional batch). This is architecturally a bigger change
than the correctness fix: `findStockMovement`'s per-line idempotency check currently runs
*before* deciding what to write, interleaved with live lookups — a single atomic batch can't
interleave conditional lookups between its writes, so this needs a real redesign (bulk-check all
lines' existing movements first, then submit one batch containing only the writes actually
needed), not a mechanical swap. Scoped as a distinct follow-up; the correctness bug it was
originally paired with is now independently fixed. `npm run test:offline` (154/154) and `npm run
test:vercel` (3/3) pass.

**Gap found and fixed (follow-up session): the same two-lines-same-product ambiguity T3 fixed for
cloud stock-movement bookkeeping was still live in the refund-quantity-selection UI and logic
itself.** Reported by the client with a screenshot: refunding one line of a product (e.g. 3 loose
pieces) showed the same return quantity on a *separate* line of the same product (e.g. a case of
10) in the Receipt Lookup refund screen.
Was: this went deeper than the UI. `lookupReturnQty` (`src/cashier-pos/pages/Cashier.jsx`) — the
state backing each line's return-quantity input — was keyed by `productId`, so two lines of the
same product shared one input value; the row `key` and `returnedQuantityForItem` (computing each
line's remaining refundable balance) had the same productId-only issue. Worse, the actual
refund-processing function, `adjustLocalSale` (`src/cashier-pos/offline/saleRepository.js:298-303`,
predates this session), matched the caller's requested quantities against the sale's stored lines
by productId only — meaning even a UI fix alone would not have been sufficient: a requested
quantity on one line would still have silently applied to *every* stored line of that product, at
the layer that actually decides how much stock and money to return. This is a correctness bug, not
just a display glitch — it could over-restock, under-refund, or misattribute an amount to the
wrong line.
Fix: `Cashier.jsx` now keys `lookupReturnQty`, the row `key`, `returnedQuantityForItem`, and the
adjustment submission payload by `item.lineId || productId`, and includes `lineId` in each
submitted return item. `adjustLocalSale` now matches by two maps — an exact `lineId` match when the
caller supplies one (the cashier UI, post-fix, always does), falling back to a `productId` match
only when it doesn't (a sale with a single line of that product, or an older/simpler caller) —
rather than requiring an exact key match on both sides, which would have wrongly rejected the
legitimate single-line case (every *stored* line always has a real `lineId` once finalized, per
T3, even when a caller's request doesn't supply one — an existing regression test caught this
exact mismatch during development). The "already refunded" balance calculation gets the same
lineId-first treatment, so a partial refund of one line no longer reduces the refundable balance
shown for a different line of the same product.
New `tests/return-disposition.test.js` cases: refunding one line of a two-line-same-product sale
leaves the other line's stock/balance untouched in both directions (refund the case, the loose-
piece line's full balance is still available; and vice versa). `npm run test:offline` (226/226)
pass; `npm run build:cashier` clean.

---

## H — Hygiene / non-POS

**H1. HIGH (repo weight). ✅ FIXED (this session, tracking only — history unchanged).**
`db_json_export/` (176 MB across 50 files, raw legacy transaction/customer records) is now
gitignored and untracked (`git rm -r --cached`). Files remain on disk; this does not shrink
existing git history (a `git filter-repo`/BFG pass would be a separate, larger decision).

**H2. HIGH (process). ✅ FIXED (this session).**
Was: no CI ran tests or lint at all, and `test:offline` named files explicitly while 9 test files
existed that no npm script executed (`payment-flow.test.js`, `cash-sales.test.js`,
`shift-close-receipt.test.js`, `cashier-transaction-restore.test.js`,
`cashier-login-barcode.test.js`, `audit-log-parsing.test.js`, `product-pricing.test.js`,
`receipt-pdf.test.js`, `developer-mode.test.js`).
Fix: new `.github/workflows/ci.yml` runs `lint`, `test:offline`, `test:vercel` on every push/PR to
`main`. `test:offline` now runs `scripts/run-offline-tests.mjs`, which discovers every
`tests/*.test.js` file automatically (excluding only `admin-vercel-boundary.test.js`, which has
its own named script for a distinct concern) instead of a hand-maintained list — new test files
can no longer be silently orphaned. All 9 previously-orphaned tests now run; 8 passed as written
and one (`shift-close-receipt.test.js`) had a genuinely stale assertion (checked for
`"SHIFT CLOSE REPORT"`/`"Actual Cash Ending"`, text the receipt code never produced — the real,
current labels are `"Z-READ REPORT"`/`"Counted Cash"`) — fixed the assertion to match actual
behavior, not the source. `npm run test:offline` is now 181/181.

**H3. MEDIUM. ✅ FIXED (this session).**
`docx` moved from `dependencies` to `devDependencies` — it has zero runtime imports; only the
unwired `scripts/generate_*.{js,cjs}` doc generators use it, and keeping it as a dev dependency
preserves those scripts for whoever maintains `USER_MANUAL.docx` etc. without shipping it in
every production install. `package-lock.json` updated (`npm install --package-lock-only`). Every
other dependency confirmed genuinely used (`@tauri-apps/plugin-updater` is dynamically imported
at `src/components/DesktopUpdater.jsx:22` — a false positive, correctly left alone).

**H4. LOW. ✅ FIXED (this session).**
`MERGE_COMPLETION_SUMMARY.md`, `MERGE_EXECUTION_GUIDE.md`, `RESTRUCTURING_NOTES.md`,
`QUICK_START_CHECKLIST.md`, `SETUP_INSTRUCTIONS.txt` moved to `docs/process/` (`git mv`, history
preserved). No other file referenced their root-level paths. **Not done:**
`scripts/debug-pb-login.mjs` left in place — deleting or moving someone's debug tool without
knowing whether it's still in active use is a judgment call for the client, not something to
guess at during a cleanup pass.

**H5. LOW. ✅ FIXED (this session).**
`allowsCashierBarcodeLogin` (`src/cashier-pos/utils/cashierLoginPolicy.js`) renamed to
`isBarcodeProvided` — the old name implied a real policy gate (format validation, an allow-list)
that never existed; it only ever checked for a non-empty value, and the actual authority is the
server (`POST /api/cashier/auth/barcode`). Behavior unchanged — deliberately did not add stricter
format validation (e.g. digit-only) without evidence of the full range of legitimate barcode
formats this system accepts; renaming for honesty was the safe fix, inventing new validation
rules was not. The old test's name and assertions were also misleading (asserted nothing specific
to a "92" prefix despite the test name); rewritten to match what the function actually does.

---

## Status as of this session's remediation pass

Every item in this register is now either **✅ FIXED**, **🔶 PARTIALLY FIXED** (with the
remaining piece spelled out inline, not silently dropped), or explicitly called out as
**deferred** with a reason. Nothing was rushed to look complete — see each finding above for the
exact boundary of what landed.

**Still open, real work:**
- **S2/M1/T3 — ✅ DONE (client, post-session).** Both schema migrations
  (`scripts/add-refund-reporting-schema.mjs`, `scripts/add-sale-item-line-id.mjs`) have been run
  against production and verified present (`sales.refunded_amount/refunded_units/refunded_at`,
  `sale_adjustments` collection, `sale_items.line_id` all confirmed via a idempotent re-run showing
  "already exists" for every field/collection). The PocketBase superuser password and
  `DEFAULT_CASHIER_PASSWORD` have also been rotated via the PocketHost dashboard. S2's remaining
  open piece is only the optional git-history rewrite (item 3 in S2 above), which was always framed
  as optional.
- **S4 — ✅ DONE (follow-up session).** Support-ticket mail relay hardened; see S4 above.
- **S6, S7, S8** (default-password policy, delete guard, CORS tightening) — real findings, never
  in scope for this pass (which targeted the approval-barcode/credential/auth-bypass/
  privilege-escalation cluster specifically).
- **M1 — ✅ DONE (follow-up session).** Schema, cloud write, and dashboard/FSN report wiring are
  all complete; see M1 above.
- **T3**: the correctness bug (same-SKU-two-lines under-deduction) is fixed; the `pb.createBatch()`
  request-volume optimization is a separate, larger redesign, not done.
- **H4**: `scripts/debug-pb-login.mjs` left in place, a judgment call for the client.

Full rationale and step-by-step detail for the plan this session executed lives in
`C:\Users\ASUS\.claude\plans\run-another-audit-check-golden-wave.md`. Every fix landed with a test
written first; `npm run test:offline` is 181/181 and `npm run test:vercel` is 3/3 as of this
register, both now wired into CI (`.github/workflows/ci.yml`).
