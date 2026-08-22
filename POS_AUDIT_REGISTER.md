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

**S2. CRITICAL — Live superuser credentials committed. ✅ PASSWORD ROTATED (follow-up session);
optional history rewrite still not done.**
Was: `.env.example:3-8` held `POCKETBASE_URL=https://nexasystems.pockethost.io`,
`POCKETBASE_SUPERUSER_EMAIL=admin@email.com`, `POCKETBASE_SUPERUSER_PASSWORD=admin123`,
`DEFAULT_CASHIER_PASSWORD=cashier123` — byte-identical to the working `.env`, so these were real
values, not placeholders. `.env` itself is correctly gitignored and was never committed;
`.env.example` was tracked and these values are in git history already.
File fix (earlier this session): `.env.example` now holds placeholders only. This alone did not
remove the real values from git history — anyone with a clone still had `admin@email.com` /
`admin123` from an old commit, and the password kept working against production until rotated.
**Password rotation (this follow-up, done with the client's explicit go-ahead):** by this point in
the session, working superuser connectivity had already been confirmed live (used for the M9
schema migrations), so the rotation was performed directly via the PocketBase API rather than left
for the client to do manually through the PocketHost dashboard:
1. Authenticated as the superuser with the old (leaked) password, called
   `pb.collection('_superusers').update(id, { password, passwordConfirm, oldPassword })` with a new
   28-character random password.
2. Verified from a fresh client (not reusing the authenticated session) that the new password
   authenticates successfully, and separately confirmed the old, leaked password no longer works at
   all — both checked directly against production, not assumed.
3. Updated the real `.env` (gitignored, confirmed via `git check-ignore` before writing) with the
   new value immediately, so nothing on this machine broke.
4. `DEFAULT_CASHIER_PASSWORD` (the fallback password used when a staff account is created without
   an explicit one) was rotated to a new random value the same way, in `.env` only — this is an
   app-level constant, not a PocketBase account, so there was no server-side value to update, but
   **it does not retroactively change any cashier account already created under the old default**;
   any such account still has `cashier123` as its actual login password until an admin resets it.
5. **Client-side action required immediately after this rotation, not yet confirmed done:** the
   Vercel-deployed web admin portal reads both of these from its own environment variables (set in
   the Vercel dashboard, not from any file in this repo) — the client confirmed they have access
   and would update it themselves right after the rotation. Until that update happens, the
   Vercel-hosted server's PocketBase authentication will fail on every request that needs the
   superuser connection.
**Still not done, optional:** rewriting git history (`git filter-repo` or BFG) to purge the old
commit(s) that hold `admin@email.com` / `admin123`. No longer strictly necessary for security now
that the password is rotated and confirmed non-functional, but the URL and old credential *pattern*
stays visible in history either way unless rewritten — the client's call, not defaulted to here.

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

**S6. MEDIUM — Hardcoded fallback password with no forced change. ✅ FIXED (follow-up session).**
Was: `server/formatters.js:194`'s `cashierPayload` fell back to
`process.env.DEFAULT_CASHIER_PASSWORD || 'cashier123'` whenever the caller omitted a password —
a predictable, shared default every such account would silently carry. Checked the Tauri app's
own local `cashierPayload` (`src/admin-page/services/desktopApi.js:772-797`) for the same gap:
it does not have one — it only includes `password`/`passwordConfirm` in the payload when the
caller actually supplies one, which PocketBase's own schema validation would reject outright
(password is a required field on the `users` auth collection), so the vulnerability was isolated
to the Express/Vercel path. The admin UI's own form (`CashierManagement.jsx:157-160`) already
requires a real, ≥8-character password for a new account, so this fallback was effectively
unreachable through normal use — but a direct API call bypassing the form would still hit it.
Fix: `cashierPayload` no longer invents a password at all (returns `''` if none supplied);
`POST /api/cashiers` now rejects the request outright with a 400 if the password is missing or
under 8 characters, matching the client-side rule as a real server-side backstop instead of
trusting JS validation alone. New `tests/cashier-create-password.test.js` (3 cases): no password
supplied never falls back to the literal string or the env var (tested by temporarily setting
`DEFAULT_CASHIER_PASSWORD` and confirming it's still ignored), and a real supplied password still
passes through correctly. `npm run test:offline` (239/239) and `npm run test:vercel` (7/7) pass.

**S7. MEDIUM — No self-delete or last-admin guard on account deletion. ✅ FIXED (follow-up
session).**
Was: `DELETE /api/cashiers/:id` (`server/index.js`) went straight to
`pbCollection('users').delete(id)` with no checks at all — it would delete the caller's own
account, or the last remaining admin account, with nothing to stop it and no recovery path short
of direct PocketBase access. The Tauri app's own local `deleteCashier`
(`src/admin-page/services/desktopApi.js:2629`) is a completely separate code path that talks to
PocketBase directly and had the identical gap.
Fix: extracted the decision logic into a new pure, shared helper,
`src/utils/accountDeletionGuard.js`'s `accountDeletionError({ targetId, callerId, targetRole,
otherAdminCount })`, so both call sites enforce the identical rule instead of two hand-written
copies that could drift apart. Wired into both: the Express route now checks self-delete before
ever touching PocketBase, then fetches the target's role and (only if it's an admin) the count of
other admins, before allowing the delete. The Tauri app does the same against the live cloud when
reachable; when offline, deleting a regular cashier is unaffected (unchanged from before), but
deleting an admin account specifically is blocked with a clear message asking to reconnect first —
the last-admin count can't be verified reliably from a single terminal's local cache. New
`tests/account-deletion-guard.test.js` (6 cases): self-delete blocked, last-admin blocked, deleting
an admin allowed when others remain, deleting a regular cashier always allowed, self-delete takes
priority even over the last-admin case, and a missing caller id doesn't crash or false-block. `npm
run test:offline` (245/245) and `npm run test:vercel` (7/7) pass.

**S8. MEDIUM — ✅ FIXED.** CORS accepted any `*.ngrok-free.dev` origin with `credentials: true`
whenever `NODE_ENV !== 'production'`, which none of this project's own npm scripts (`api`,
`start`, `host`, `deploy`) ever set — so the permissive ngrok/local-network rule, meant only for
Local Coding Mode, LAN Team Testing Mode, and Remote Demo Mode (see README.md), was live by
default in any real deployment that used this server directly. Separately, `isSameRequestOrigin`
(`server/index.js:65-72` pre-fix) trusted the client-supplied `X-Forwarded-Host` header as proof a
request's Origin matched the host it arrived at — that header is not something only a trusted
proxy can set, so any direct caller could forge it to bypass the allowlist entirely.
Fix: flipped the permissive rule from opt-out to fail-closed. It's now gated by a new, explicit
`ALLOW_DEV_CORS_ORIGINS=true` env var (default unset/false) instead of `NODE_ENV`, documented in
`.env.example` and in the three README modes that need it. `isSameRequestOrigin` no longer reads
`X-Forwarded-Host` at all — it now compares only against Express's own `req.get('host')`, extracted
into a small pure helper, `src/utils/corsOrigin.js`'s `isSameHost(requestHost, originHost)`, so the
comparison logic is unit-tested directly. The Vercel-hosted admin portal was never affected either
way (`isVercelAdminPortal` already forced this off regardless of `NODE_ENV`), so nothing changed
for the live production surface. New `tests/cors-origin.test.js` (4 cases): identical hosts match,
case-insensitive match, different hosts rejected, either host missing is rejected. `npm run
test:offline` (249/249), `npm run test:vercel` (7/7), and a fresh-clone `npm run lint` (0 errors)
all pass.

**S9. LOW — ✅ FIXED.** `src/cashier-pos/utils/cashierLoginPolicy.js:1-5`
`allowsCashierBarcodeLogin` only rejected the empty string; its name implied a gate that did not
exist, and its test (`tests/cashier-login-barcode.test.js`) passed vacuously.
Fix: renamed to `isBarcodeProvided`, with a header comment stating plainly that this is only a
client-side "don't bother the network with an empty field" pre-check -- the real authority is the
server (`POST /api/cashier/auth/barcode`), which looks the scanned value up against real accounts.
The test was renamed and reworded to match: `any non-empty barcode value passes the pre-check` /
`an empty or whitespace-only value does not`, dropping the old test's misleading name ("allows
cashier barcode login for barcodes that start with 92") which asserted nothing "92"-specific at
all. `npm run test:offline` passes with this file's 2 cases included.

---

## M — Money correctness

**M1. CRITICAL — Refunds never reach the cloud at all. ✅ FIXED (follow-up session) — schema,
cloud write, and report wiring are all complete; see "Done" and the follow-up note below.**
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
  file's header comment for the reasoning. **Now run against production** (confirmed live: `sales`
  has `refunded_amount`/`refunded_units`/`refunded_at`, and `sale_adjustments` exists) — the client
  ran `npm run pb:migrate:refund-schema` directly, as planned this session.
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

**✅ Now fully FIXED (follow-up session): the Tauri admin app's own, independent dashboard/FSN
builders net refunds too, matching the web admin.**
Was: `src/admin-page/services/desktopApi.js`'s `buildDashboardFromRecords` and `buildFsnMetrics`
are a **separate, parallel implementation** — not a call into the Express `/api/dashboard`/
`/api/inventory/fsn` routes fixed above — summing raw `total_amount`/`quantity_sold` with no
refund awareness, merging local (not-yet-synced) sales with cloud PocketBase records for
offline-first support. Since the Tauri app is the client's primary app, refund data recorded via
M1's cloud write was reaching the cloud but not reflected in the dashboard actually looked at day
to day — only the secondary Vercel web admin, if used, showed netted figures.
Fix: extracted the server-side `refundedUnitsBySaleAndProduct` into shared
`src/utils/saleTotals.js` (now imported by both `server/index.js` and the admin desktop app, so
the two dashboards can never silently drift apart on how refunds are netted) and applied the same
revenue (`netSaleAmount`) and per-(sale,product) unit netting to `buildDashboardFromRecords` and
`buildFsnMetrics`. The harder half was the local/cloud merge this offline-first dashboard already
does: a local, not-yet-synced sale carries its refund data inline (`sale.adjustments[]`), while a
cloud sale carries `refunded_amount`/`refunded_units` directly and its per-product detail in the
separate `sale_adjustments` collection — new `src/utils/localSaleAdjustments.js`
(`refundedAmountAndUnits`, `localAdjustmentsNotYetSynced`) bridges the two shapes and, critically,
**deduplicates by `adjustment_id`** so a refund that has since synced to the cloud is never counted
from both its local and cloud copies at once (which would double-net it). Wired into all three
branches of `dashboard()` (local-only, cloud-unreachable fallback, full cloud merge) and
`fsnInventory()`.
New `tests/local-sale-adjustments.test.js` (6 cases) and a `tests/sale-totals.test.js` addition for
the camelCase `saleId` variant local adjustments use (vs. cloud's snake_case `sale_id`). The
`buildDashboardFromRecords`/`buildFsnMetrics` wiring itself has no automated test coverage — same
`import.meta.env` limitation as elsewhere in this file (`desktopApi.js` can't be imported directly
in a plain Node test); verified via `esbuild` bundle-check and the full regression suite instead.
`npm run test:offline` (233/233) and `npm run test:vercel` (7/7) pass; `npm run build`,
`npm run build:vercel`, and `npm run build:cashier` all clean.

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

**M9. HIGH — Deleting a product with sale/stock history silently fails cloud-side and the product
reappears. ✅ FIXED (this session, three layers).** New finding, not in the prior tracker or
register — surfaced by the client noticing products they'd deleted coming back after "sometime,
or the next day." Had three stacked causes; each of the first two fixes was real and necessary but
not sufficient on its own — found out because the client re-tested after each fix and reported the
product still coming back, which is what kept the investigation going instead of stopping early.

Layer 1 — the hard delete itself was silently failing. Any product that has ever been sold or had
a stock movement is referenced by PocketBase relation fields (`sale_items.product_id`,
`stock_movements.product_id`), so a hard `products.delete()` against it is rejected with a
relation-constraint error — true for essentially every real, in-use product. Both delete paths
(`src/admin-page/offline/syncEngine.js`'s `deleteProduct` op handler for the Tauri app, and
`server/index.js`'s `DELETE /api/products/:id` for the Vercel web admin) caught that specific
error and treated it as success: the product was marked deleted only in the *local* terminal's own
cache (`adminDb.products`), while the cloud record was left fully live and untouched. Fixed by
falling back to setting the cloud record's `lifecycle_status: 'archived'` instead of silently
no-opping, reusing the existing Archive feature already wired everywhere in the app (cashier
catalog filters, product listings, low-stock reports all already respect
`lifecycleStatus !== 'active'`). A genuine hard delete (a product with no sale/stock history at
all) is unaffected and still removes the record outright.

Layer 2 — the deeper, pre-existing bug, unrelated to delete specifically, that made Layer 1's fix
(and the already-existing, separate Archive button) both look broken: confirmed by asking the
client to test the *pre-existing* Archive feature in isolation, which also failed the same way —
proving the problem was never really about delete. Root cause in
`src/admin-page/offline/productSyncUtils.js`'s `mergeProductWithCloudRecord`: when a periodic full
catalog pull (`CLOUD_PULL_INTERVAL_MS`, runs regularly during normal use) lands while an
`updateProduct` op for that same product is still queued and not yet uploaded, the merge's
"preserve local changes" branch only ever preserved `qty` — it spread the *stale, pre-edit* cloud
record first and kept nothing else from the pending local edit. Any field changed by an edit that
hadn't synced yet (name, price, category, and critically `lifecycle_status`) silently reverted to
its pre-edit value the moment that pull landed — which given how often periodic pulls run, was
often within seconds of the edit. This is why Archive (and Delete, once routed through the same
archive mechanism) appeared to instantly "undo itself." Fixed by checking for a queued
`createProduct`/`updateProduct` op on the product *before* falling into the qty-only preserve
branch, and if one exists, keeping the entire local record as-is rather than cherry-picking a
single field — the cloud snapshot cannot be trusted for this product at all until that op syncs.
New `tests/product-delete-relation-constraint.test.js` (2 cases, Layer 1) and a new case in the
pre-existing `tests/product-delete-sync.test.js` (Layer 2, alongside its existing qty-preservation
tests) proving a queued lifecycle/name/price edit survives an intervening stale cloud pull.
`npm run test:offline` (236/236) and `npm run test:vercel` (7/7) pass. Verified against a
genuinely clean `npm ci` checkout as well as the local sandbox, since this session's CI run
separately surfaced that the local sandbox's `node_modules` had drifted enough to mask real lint
failures.

Layer 3 — the actual, decisive root cause, found only by connecting directly to the live
production PocketBase (`nexasystems.pockethost.io`) and inspecting its real schema, rather than
trusting `pocketbase/pb_schema.json` as ground truth: **`products.lifecycle_status` did not exist
on production at all.** `pb.collections.getOne('products').fields.find(f => f.name ===
'lifecycle_status')` returned `undefined`. The field only ever existed in the repo's local schema
reference file — a snapshot of what the schema is supposed to look like — and was never actually
applied to production as a real migration, unlike every other schema addition in this register
(M1's refund fields, T4's `sale_item.line_id`), which all shipped with a `scripts/add-*.mjs`
migration script. This one never had one. PocketBase does not reject writes to an unrecognized
field name — it silently accepts and discards them — so both the pre-existing Archive button
(which predates this session entirely) and Layers 1–2's fixes had been writing
`lifecycle_status: 'archived'` into the void the whole time; the write always "succeeded" and did
nothing, which is exactly why the product kept looking untouched. Layers 1 and 2 were both real,
correctly-diagnosed bugs and remain necessary — they just could not do anything visible until this
field actually existed to write to. Fixed with a new additive-only migration script,
`scripts/add-product-lifecycle-schema.mjs` (mirrors `add-refund-reporting-schema.mjs`'s pattern),
run against production this session (`npm run pb:migrate:product-lifecycle`) with working
superuser connectivity confirmed live — unlike M1's schema migration, which was written but left
for the client to run due to no connectivity at the time. Verified after running: fetched the live
`products` collection schema and confirmed the field now exists with the expected `select` type
and `[active, inactive, archived]` values; round-tripped a real write/read against an actual
production product (`prd000000000001`, "MILO 24g") — set `lifecycle_status: 'archived'`, read it
back as `'archived'`, then reverted it to `'active'` to leave no test data behind. Client should
re-test Delete and Archive now that all three layers are in place; if it still reappears, the next
thing to check is whether the reappearing product predates this fix and simply needs to be
deleted/archived once more now that the mechanism actually persists.

Layer 4 — client feedback after re-testing: reusing Archive's `lifecycle_status: 'archived'` for
Delete's fallback meant a deleted product was indistinguishable from an archived one, both showing
under the same "Archived Products" filter — "no sense of adding an archive button if the delete
button does that too." Fixed by giving Delete its own distinct status, `'deleted'`, separate from
`'archived'` end to end: the schema migration script now also adds `'deleted'` as an allowed
`lifecycle_status` select value (`ensureSelectValue`, additive, run against production this
session); both delete fallback paths (`syncEngine.js`, `server/index.js`) write `'deleted'` instead
of `'archived'`; the three places that whitelist which `lifecycleStatus` values survive a save
(`productBody` in `syncEngine.js`, `localProductFromForm` in `desktopApi.js`, `productPayload` in
`server/formatters.js`) now accept `'deleted'` too, so re-saving a deleted product's other fields
later doesn't silently reset it back to active. `ProductManagement.jsx` gained its own "Deleted
Products" filter option alongside "Archived Products" rather than folding deleted items into the
Archived view, and the restore (↺) toggle now recognizes both `'archived'` and `'deleted'` as
restorable back to `'active'`. Updated `tests/product-delete-relation-constraint.test.js` to assert
`'deleted'` specifically (and that it is *not* `'archived'`). `npm run test:offline` (236/236) and
`npm run test:vercel` (7/7) pass; verified against a clean `npm ci` checkout and all three
production builds.

**M10. MEDIUM — "Total Products" and stock-composition stats counted archived/deleted products.
✅ FIXED (follow-up session).** Flagged during a client Q&A about M9 (deleted products), never
separately confirmed until now.
Was: once M9 gave a deleted or archived product its own `lifecycle_status` instead of vanishing,
Inventory's "Total Products" stat (`Inventory.jsx:202`, `products.length`) and Dashboard/Analytics'
stock-composition stats (`criticalStock`, `criticalAlerts`, `productInOut`'s Current Stock,
`inventoryHealth`'s in-stock/low/critical/out-of-stock breakdown, `dataQuality`) all summed over
every product Dexie/PocketBase had a row for, with no lifecycle filter at all — both in
`src/admin-page/services/desktopApi.js`'s `buildDashboardFromRecords` (Tauri app) and
`server/index.js`'s duplicate of the same logic (Vercel admin portal). An archived or deleted
product isn't part of the sellable catalog, so it inflated "how many products do I stock," could
trigger a restock alert for stock that will never sell again, and counted toward Current Stock
units that no longer exist as active inventory.
Fix: new shared pure helper, `src/utils/productLifecycle.js`'s `isCatalogActive(product)` —
excludes only `'archived'` and `'deleted'`; `'inactive'` still counts, since that status means
temporarily disabled, not removed. Applied to the stock-composition aggregates only, in both
`buildDashboardFromRecords` (desktopApi.js) and the equivalent block in `server/index.js`, plus
Inventory.jsx's three stat cards (Total Products, low-stock alert count, stock value). Deliberately
**not** applied to `productLookup`/`productsById` (used to resolve a past sale item's product name
and category) or to `buildFsnMetrics` — a product sold before being archived must still resolve
correctly in historical sales reports, and barcode scanning/search on the Inventory page is
unaffected. New `tests/product-lifecycle-catalog.test.js` (6 cases): no-status defaults active,
explicit active, inactive still counts, archived excluded, deleted excluded, snake_case field name
from raw PocketBase records honored. `npm run test:offline` (255/255), `npm run test:vercel` (7/7),
a fresh-clone `npm run lint` (0 errors), and `npm run build` all pass.

**M11. HIGH — Reprinting a receipt could physically print multiple copies (raw thermal-print path
squared its own copy count). ✅ FIXED (follow-up session).** Reported by the client: printing a
receipt sometimes produced 3 copies from the printer.
Was two separate bugs stacked on top of each other:
1. `handleLookupReprint` and `handleHistoryReprint` (`src/cashier-pos/pages/Cashier.jsx`) — the
   Receipt Lookup screen's Reprint button and the Recent Transactions list's Reprint button — called
   `printCompletedReceipt(receiptData)` with no `options` argument at all, so the copy count silently
   fell through to `VITE_RECEIPT_COPIES`/the `1`-copy default inside `receiptTexts`
   (`src/cashier-pos/services/receiptPrinter.js`). The normal post-checkout print (`printReceiptCopy`
   in `Cashier.jsx`) and the general "Reprint Receipt" button both already explicitly forced
   `copies: 1` — the two reprint entry points above were the only ones that didn't, an inconsistency
   with no reason behind it.
2. The deeper bug, in `printCompletedReceipt`'s raw ESC/POS branch (`receiptPrinter.js:449-479`):
   `contents` was built as `receipts.join('\n')` — `copies` identical receipt texts concatenated
   into *one* string — and that same `copies` value was *also* passed to the Rust side
   (`src-tauri/src/lib.rs`'s `print_receipt_impl`), which sends whatever `contents` it's given
   `copies` more times in its own loop (`for _ in 0..copies { ... WritePrinter ... }`, confirmed by
   reading the implementation directly). Requesting N copies therefore printed N × N copies — the
   two layers each independently tried to produce the repeat count, multiplying instead of adding.
   At the `copies: 1` call sites this was invisible (1×1=1), which is why it went unnoticed until a
   reprint path exercised any value above 1.
Fix: `receiptPrinter.js`'s raw-print branch now always builds `contents` from a *single* receipt
(`buildReceiptText(receiptData)`), and `copies` is the only place the repeat count lives — matching
what the Rust loop already correctly does per iteration (a separate `StartDocPrinterW`/
`EndDocPrinter` job per copy, which is also the correct behavior for auto-cutting thermal printers).
The same fix was applied to the fallback retry branch (blank-printer-name retry on a
"printer was deleted" error), which had also hard-coded `copies: 1` regardless of how many copies
were actually requested. Separately, `handleLookupReprint` and `handleHistoryReprint` now pass
`{ copies: 1 }` explicitly, matching the two print paths that already did — plus the two PDF
"test print" call sites (`handlePrintReceiptPdf`, `handleLookupPrintPdf`) for the same consistency,
since a PDF test print reprinting N pages for a single receipt had the identical inconsistency
(harmless there, since PDF pages aren't physically wasted paper, but still the wrong default).
**Not automatically tested:** `receiptPrinter.js` (like the rest of this file, its only currently
tested export is the pure `buildReceiptPdf`) references `import.meta.env` at module load, which is
`undefined` under plain `node --test` and throws on import — the same constraint that already keeps
this file out of automated coverage elsewhere in the codebase. Verified by direct code trace of both
the JS join/copies logic and the Rust `print_receipt_impl` loop (quoted above), plus a fresh-clone
`npm run lint` (0 errors) and `npm run build`/`npm run build:cashier` (both clean) confirming nothing
else broke. `npm run test:offline` (255/255) and `npm run test:vercel` (7/7) pass (unrelated to this
fix, confirming no regression elsewhere).

**M12. MEDIUM — A failed non-product sync operation had no way to be cleared from the Sync
Center; it stayed "Failed" forever. ✅ FIXED (follow-up session).** Reported by the client via a
screenshot from a real terminal (POS-25A2EE): an `UpdateStaff` op for a cashier
("SYRA MAE ENARIO") stuck at `Failed · The requested resource wasn't found.`, with no button to
resolve or dismiss it, unlike the other two items in the same screenshot (a duplicate-barcode
product conflict and a stale-product-data conflict, both of which already had working resolution
paths — see below).
Was: `Sidebar.jsx`'s Sync Center only ever rendered a "Discard" button for failed *product* ops
(`isDiscardableProductFailure` explicitly checks `type` against
`['createProduct','updateProduct','deleteProduct']`), because discarding a failed product op also
deletes that product's local cached copy (`discardFailedProductSync` in `desktopApi.js`) — there
was no equivalent path for any other Admin op type. A 404 on retry (the target record was deleted
or replaced elsewhere) can never succeed no matter how many times "Retry All" is clicked, so an op
like this was permanently stuck with zero way to clear it from the UI.
Fix: new `discardFailedSyncOperation(id)` (`desktopApi.js`) — deliberately much simpler than the
product version, since a failed non-product op has no local cache to clean up; it only ever
removes the stuck queue entry itself, never touches the actual cloud record (if the edit still
needs to be made, it has to be made again). Wired into `Sidebar.jsx` via a new
`isDiscardableOtherFailure` check (any Admin-sourced failed op that isn't one of the three product
types) with its own "Discard" button, explicit in its confirmation dialog that this only clears
the stuck entry and does not affect the cloud.
**Not a bug — for context, since the same screenshot raised them:** the duplicate-barcode product
conflict ("C2 SOLO 24'S") and the stale-cloud-data conflict ("MARLBORO RED CRAFTED") both already
have working resolution paths in this same UI (the existing product-discard button once an op
exceeds `MAX_ATTEMPTS` and flips to `failed`, and the Use Cloud/Review Fields/Use Local buttons for
`conflict`-status ops respectively) — they require a one-time manual decision from whoever is at
that terminal (pick a different barcode; choose which version of the product to keep), not a code
fix. Confirmed via a direct query against production PocketBase that this was a real, currently-
used terminal (16 shift sessions, 661 activity log entries from real staff), not sample data.
**Not automatically tested:** same `import.meta.env` constraint as the rest of `desktopApi.js` (see
M11's note above) keeps this out of the plain-`node --test` suite. Verified by direct code trace,
a fresh-clone `npm run lint` (0 errors), and `npm run build` (clean). `npm run test:offline`
(262/262) unaffected, confirming no regression elsewhere.

**M13. MEDIUM — Every cashier barcode scan did redundant local work, regardless of catalog
freshness. ✅ FIXED (follow-up session).** Reported by the client: barcode scanning in the
Cashier screen "is not that fast."
Was: `productByBarcode` (`src/cashier-pos/services/desktopApi.js`) ran a second, separately-
implemented product lookup against an *entirely different* local database (the admin app's own
cache, via `adminCachedProductByBarcode`) unconditionally on every scan, including on the common
path where the cashier's own lookup (`getProductByBarcode`, which already has its own indexed-then-
scan fallback for selling-unit barcodes) had already succeeded. On a barcode that wasn't a
product's primary barcode -- e.g. scanning a case/bulk barcode, a routine scenario in this catalog
-- `adminCachedProductByBarcode` falls back to a full table scan of the admin catalog, checking
every product's `sellingUnits` array. Every scan also unconditionally wrote the (often unchanged)
result back to IndexedDB via `cashierDb.products.put(...)`. Confirmed via git history
(`git log -S`) that this was introduced 2026-07-11 in an unrelated, undocumented commit ("fix bugs
in scan product") over a month before this session's work and unconnected to any rate-limiting
fix -- an accidental performance regression, not an intentional design tradeoff. Immediately below
this same block, the *network* fallback already correctly used a `!product` ("true cache miss")
guard before paying for a live PocketBase round-trip -- this admin-cache block was the one path
that had lost its equivalent guard.
Fix: gated the admin-cache fallback (and its IndexedDB write) behind the same `!product` check the
network fallback already used, and removed a second, now-fully-redundant admin-cache lookup a few
lines below it (`adminCachedProducts()` + a manual `.find()` loop) that duplicated the same "check
admin cache on a true miss" responsibility less efficiently (`adminCachedProductByBarcode` already
tries an indexed lookup before its own full-scan fallback). Net effect: a scan that already resolves
from the cashier's own local catalog -- the overwhelming majority of scans -- no longer touches the
admin database, does no full-catalog scan, and writes to IndexedDB only when something actually
changed. Downloading the latest catalog for offline use (Settings) remains separately good advice
for a different reason: it reduces how often a scan falls into the genuinely-network-bound "true
cache miss" branch further down the same function, unaffected by this fix.
**Not automatically tested:** same `import.meta.env` constraint as M11/M12 above. Verified by
direct code trace and git-history review, a fresh-clone `npm run lint` (0 errors), and
`npm run build:cashier` (clean). `npm run test:offline` (262/262) unaffected.

**M14. HIGH — A cashier whose session expired had no reachable way to fix it, and one status
indicator actively told them the wrong problem. ✅ FIXED (follow-up session).** New finding,
reported by the client: a cashier terminal showed "the internet is connected, but this cashier
session has no cloud authorization," and separately looked "offline" -- confusing, since the two
signals contradicted each other and neither told the cashier what to actually do.
Was three compounding bugs, two in `src/cashier-pos` UI code and one in the sync engine itself
(the client's report described both symptoms in the same message -- "product catalog not
refresh, something went wrong" *and* "no cloud authorization" -- because both are the same root
cause surfacing through two different, separately-broken paths):
1. The interactive re-auth popup (`showCloudAuth`, with email/password fields,
   `Cashier.jsx`) only ever opened from the manual "Sync Now" button's own result-handling
   (`handleSyncNow`). The far more common path -- the periodic ~60s *automatic* background sync
   hitting the exact same "no cloud authorization" condition (`syncEngine.js:459-469`) -- had no
   listener wired to open it at all. A cashier who never happened to click "Sync Now" themselves
   after their session expired had no discoverable way to reach the fix that already existed in
   the code; the only visible signal was a small, non-interactive status badge
   (`SyncStatusIndicator.jsx`).
2. `ConnectionStatusBar.jsx` explicitly grouped `auth-required` together with `offline`, labeling
   it "Offline" with the message "Changes are saved locally and will sync later." That's actively
   wrong -- this isn't a connectivity problem (a normal cashier or barcode login mints a session
   token; barcode-login tokens specifically last only 12 hours vs. a password login's 7 days, by
   design -- see S1 -- so any barcode-login session left open past 12 hours will eventually hit
   this), and telling a cashier with a working internet connection that their internet is the
   problem sends them to check the WiFi instead of logging back in.
3. **Found investigating the "product catalog not refresh" half of the report specifically:** the
   pre-emptive "no cloud authorization" guard only runs when there are queued sales/ops waiting
   (`syncEngine.js:459`). A terminal with nothing queued -- just a periodic catalog refresh coming
   due -- skips that guard entirely, attempts the refresh, and if the session has expired the
   request fails with a 401. That failure was indistinguishable from any other refresh failure
   (a network blip, a genuine 500): both produced a generic `"Product catalog could not refresh:
   <raw error>"` message -- for an expired session specifically, PocketBase's raw error text is
   often just `"Something went wrong."`, exactly matching the client's report -- with `state:
   'waiting'`, never `'auth-required'`, so neither of the two UI fixes above would have caught it
   either.
Fix: `Cashier.jsx` now listens for the `nexa-sync-status` event directly (the same event both
status components already listen to) and opens the re-auth popup itself whenever `auth-required`
fires for the cashier scope, regardless of whether a manual or automatic sync triggered it.
Dismissing the popup without fixing it (Cancel, or closing it) sets a 10-minute cooldown so it
doesn't immediately reopen on the very next automatic sync tick if the cashier can't deal with it
mid-transaction. `ConnectionStatusBar.jsx` now gives `auth-required` its own distinct, correctly-
worded state ("Login required," warning tone -- reusing the `warning` CSS class already used for
`failed`/`waiting`, no new styles needed) instead of folding it into "Offline." `syncEngine.js`'s
catalog-refresh catch block now detects specifically whether the failure was a 401 (or the SDK
having already invalidated `pb.authStore` in response to the same request) and, only in that case,
reports it through the exact same `'auth-required'` state and message as the pre-emptive guard --
routing it through both fixes above -- instead of the generic, opaque "could not refresh" text. A
genuine non-auth refresh failure (network blip, a real 500) is unaffected and still reports
normally.
New `tests/cashier-catalog-refresh-auth-required.test.js` (2 cases): a 401 during catalog refresh
is reported with the same "no cloud authorization" message the pre-emptive guard uses; a non-401
failure with a still-valid token keeps the generic message and is not misreported as an expired
session.
**Not automatically tested (UI half only):** same `import.meta.env`/Dexie constraints as M11-M13
keep `Cashier.jsx` out of the plain-`node --test` suite; `ConnectionStatusBar.jsx` has no existing
test harness either -- verified by direct code trace for those two. The sync-engine half (3, above)
*is* covered by the new test file, since `syncEngine.js` itself has no `import.meta.env` reference
at module scope. `npm run test:offline` (264/264), a fresh-clone `npm run lint` (0 errors), and
`npm run build`/`npm run build:cashier` (both clean) all pass.

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

**T3. Sale-upload batch rewrite. ✅ FIXED (correctness bug B3 this session; request-volume
optimization in a later follow-up session, scoped down from `pb.createBatch()` — see below).**
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
- New `scripts/add-sale-item-line-id.mjs` (additive-only migration): `sale_items.line_id`. **Now
  run against production** (confirmed live: `sale_items` has `line_id`) — same as M1's migration,
  the client ran it directly.
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
**Request-volume optimization — ✅ FIXED (follow-up session), deliberately scoped down from a
literal `pb.createBatch()` rewrite.** Client reported occasionally hitting PocketHost rate limits;
this was the remaining piece of T3 addressing it.
Before touching anything, tested `pb.createBatch()`'s actual transaction semantics directly against
production (a throwaway batch: one valid `categories.create` + one deliberately invalid one) —
confirmed it is **fully transactional**: the invalid sub-request rolled back the valid one too, and
`batch.send()` threw rather than returning mixed per-item results. Wrapping a whole sale's
`sale_items` + stock-deduction writes in one batch would mean a single bad line (a stale product
reference, an unexpected validation error) silently failed *every other line in that sale* too —
the current code's per-item independence is deliberate resilience, not an oversight, and today's
per-line retry-resumability (a retry only redoes the lines that didn't finish) would also be lost.
Given `pb.createBatch()` support would additionally have required rewriting the fake-`pb` mocks in
5 existing test files just to keep the suite runnable, the actual chosen fix targets the same
request-volume problem without introducing that all-or-nothing risk: eliminating the *redundant
reads* that made up most of the ~8–9-requests-per-line-item figure, while every write stays its own
independent, retry-safe call exactly as before.
Was: `ensureCloudSaleItems` called `products.getOne` once per line to verify its `productId` (even
for two lines of the same product), and re-fetched the **entire product catalog** inside the
per-item barcode-fallback loop for every line that needed it (3 barcode-only lines meant 3 full
catalog pulls). `ensureCloudStockDeduction` called `findStockMovement` once per line to check for a
prior interrupted attempt, `products.getOne` once per line even for a repeated product, and
`reconcileProductStock` (itself 2-3 requests) once per line instead of once per distinct product.
Fix:
- New `resolveSaleItemProductIds` (`syncEngine.js`): one bulk `products` fetch (an OR filter across
  every line's distinct declared `productId`) replaces the per-line `getOne` verification, and the
  barcode-fallback catalog fetch now happens **at most once per sale**, shared across every line
  that needs it, not once per such line.
- New `findExistingStockMovementsByReference` (`src/utils/stockMovementReconciler.js`): one bulk
  query (an OR filter across every line's `reference_id`) replaces the per-line `findStockMovement`
  calls. Deliberately does **not** swallow a request failure into "nothing found" — mirrors
  `findStockMovement`'s own documented contract, since silently treating an unknown state (a 429,
  a network blip) as "not yet deducted" is exactly what causes a double deduction on retry.
- `ensureCloudStockDeduction` now groups lines by `productId`: each distinct product is fetched
  with `getOne` once (not once per line, even if the cart has several lines of it), its lines'
  deductions are summed and applied as a single `products.update`, and `reconcileProductStock` runs
  once per distinct product instead of once per line. Every line still gets its own
  `stock_movements` audit row, chained in-memory from the one fetched starting quantity so each
  row's `previous_quantity`/`new_quantity` is still correct and contiguous.
- **Bonus correctness fix found while writing request-volume tests for this, not something this
  session set out to fix:** a barcode-fallback-resolved line's stock deduction was being silently
  skipped entirely, in both the old code and (initially) the new one — `ensureCloudStockDeduction`
  read `productId` straight from the *raw* sale data (`item.productId`), which stays empty for a
  barcode-only line; the productId that `ensureCloudSaleItems` actually resolved via barcode only
  ever reached the persisted cloud `sale_items` row, never fed back to the deduction step. Fixed by
  having `ensureCloudStockDeduction` prefer the persisted cloud sale-item's `product_id` (matched by
  `lineId`) over the raw sale data, falling back to the raw value only for legacy rows with no
  `lineId` to match by.
- New `tests/sale-upload-request-volume.test.js` (3 cases, asserting request *counts* directly,
  which the pre-existing correctness-only tests don't cover): two lines of the same product fetch/
  update that product exactly once; three lines across two products fetch/update each exactly
  once; barcode-fallback resolution fetches the catalog once for the whole sale (also asserts the
  bonus correctness fix — both resolved products end up with the correct deducted quantity, not
  silently unchanged). New tests in `tests/stock-movement-reconcile-order.test.js` (4 cases) for
  `findExistingStockMovementsByReference`: empty input makes no request, N reference ids still make
  exactly one request, duplicate reference ids are deduplicated before the request is built, and a
  request failure propagates rather than degrading to an empty map. `npm run test:offline`
  (262/262), `npm run test:vercel` (7/7), a fresh-clone `npm run lint` (0 errors), and both
  `npm run build`/`npm run build:cashier` all pass.
**Still open:** a literal single-`createBatch()`-per-sale rewrite remains possible but was
deliberately not pursued, for the transactional-risk reasons above. If PocketHost rate limits are
still a live problem after this fix ships, that's the next lever — but it would need the client's
explicit sign-off on the all-or-nothing tradeoff first, not a silent architecture change.

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
- **S6, S7, S8 — ✅ DONE (follow-up session).** Default-password policy, delete guard, and CORS
  tightening; see S6, S7, S8 above. None were in scope for this pass's original target (the
  approval-barcode/credential/auth-bypass/privilege-escalation cluster).
- **M1 — ✅ DONE (follow-up session).** Schema, cloud write, and dashboard/FSN report wiring are
  all complete; see M1 above.
- **T3 — ✅ DONE (follow-up session).** Both halves complete: the correctness bug (same-SKU-two-
  lines under-deduction) and the request-volume optimization (deliberately scoped down from a
  literal `pb.createBatch()` rewrite after confirming its all-or-nothing transaction semantics
  against production — see T3 above for the full reasoning).
- **M10 — ✅ DONE (follow-up session).** "Total Products" and stock-composition stats no longer
  count archived/deleted products; see M10 above.
- **M11 — ✅ DONE (follow-up session).** Reprint could physically print multiple copies (a real
  double-multiplication bug in the raw thermal-print path, not just a missing default); see M11
  above.
- **S9 — ✅ DONE.** Already fixed by the time this pass reached it — renamed to `isBarcodeProvided`
  with an honest comment; see S9 above.
- **H4**: `scripts/debug-pb-login.mjs` left in place, a judgment call for the client.

Full rationale and step-by-step detail for the plan this session executed lives in
`C:\Users\ASUS\.claude\plans\run-another-audit-check-golden-wave.md`. Every fix landed with a test
written first; `npm run test:offline` is 181/181 and `npm run test:vercel` is 3/3 as of this
register, both now wired into CI (`.github/workflows/ci.yml`).

---

## Re-audit pass, 2026-08-21 (fresh scan for new-terminal business interruptions)

Prompted by a live client error on POS-72F1F2 (raw "Invalid key provided" toast on the Sync
button). That led to a targeted fresh audit pass (3 parallel background reviews: sync/Dexie key
usage, money/inventory edge cases, admin-side reliability) explicitly scoped to find things NOT
already covered by S1-S9/M1-M14/T1-T3/H1-H5 above, all of which were re-confirmed still fixed with
no regressions.

**T4. HIGH — ✅ FIXED. `forceRetryNow` hardcoded `row.id` as the Dexie update key, but
`cashierDb.pendingSales`'s actual primary key field is `clientSaleId`.**
`src/utils/pendingQueueRetry.js` (shared by both apps' manual Sync button and every cashier login
via `retryPendingCashierSync`) called `table.update(row.id, patch)`. Every `pendingSales` row has
no `id` field at all (Dexie schema `'&clientSaleId, ...'`), so any row that needed patching (a
failed status, or a `nextAttemptAt` more than 60s out) passed `undefined` as the key and threw
Dexie's raw `"Invalid key provided. Keys must be of type string, number, Date or
Array<string | number | Date>."` verbatim to the user — this is exactly the error the client saw.
Also silently affected every cashier login (fire-and-forget, no visible error) and admin's manual
sync, on any terminal with a queued sale in that state.
Fix: read the table's actual key field via Dexie's own `table.schema.primKey.keyPath` instead of
assuming `row.id`. New `tests/pending-queue-retry.test.js` case reproduces the exact production
error pre-fix (verified via `git stash`) and passes post-fix. Follow-up audit pass confirmed no
other Dexie call site in either app assumes the wrong key field. `npm run test:offline` (274/274)
pass. Commit `ccd828a`.

**M15. HIGH — ✅ FIXED. A refund/exchange amount for a fractional-quantity product could drift by
fractions of a peso (unrounded money math).**
`src/cashier-pos/offline/saleRepository.js`'s `adjustLocalSale` computed
`quantity * price` for the refund amount with no rounding step. A fractional product (e.g. weighed
goods, `allowFractional`) can carry 3 decimal places of quantity; multiplied against a
centavo-rounded unit price this lands on a sub-centavo value plus raw binary-float error (e.g.
`0.3 * 33.33 = 9.998999999999999`, not `10.00`). That unrounded figure flowed straight into
`sale.adjustments[].amount`, the cloud `sale_adjustments.amount`, and additively into
`sales.refunded_amount` (M1's netting field) — silently drifting every downstream revenue and
cash-drawer-reconciliation figure by fractions of a peso over many fractional-item refunds, the
same class of bug M-series already fixed for other paths, just missed here because the
multiplication happens after the per-line `roundMoney` call rather than before.
Fix: wrap the computed amount in `roundMoney(...)`. New test in `tests/return-disposition.test.js`
(`refund amount for a fractional quantity is rounded to centavos`). `npm run test:offline`
(275/275) pass. Commit `7edf3aa`.

**M16. MEDIUM — ✅ FIXED. Staff Management's "Total Sales" column (Tauri admin only) didn't net
refunds, disagreeing with the web admin's figure for the same cashier.**
`src/admin-page/services/desktopApi.js`'s `salesByCashier()` summed raw `total_amount` with no
refund netting — a third independent implementation (per the M1 pattern already documented) that
missed the fix applied to `server/index.js`'s `getSalesByCashier` (which already used the shared
`netSaleAmount` helper).
Fix: `salesByCashier()` now calls `netSaleAmount(sale)` too — both admin surfaces agree again.
Commit `7edf3aa`.

**M17. HIGH — NOT YET FIXED. Sales-by-Cashier report and its CSV export silently drop every
refunded/exchanged sale from the totals, not just fail to net them.**
`src/admin-page/pages/CashierSalesReport.jsx`'s `generateReport()` hardcodes
`status: 'completed'` when calling `api.receipts(...)`. Any sale that's had a refund or exchange —
even a partial one — has its `status` flipped to `'adjusted'` (`saleRepository.js:436,445`,
`syncEngine.js:1004`), and both the desktop (`desktopApi.js`'s `filterReceiptRecords`) and web
(`server/index.js`'s `/api/receipts` route) receipt-filtering logic treat an explicit `status`
value as an exact match, not "at least this status" — so an adjusted sale is filtered out
entirely, not shown with a stale gross figure. This undercounts the report's revenue/quantity
totals (the sale's real, still-owed remaining revenue is missing entirely), the opposite direction
from a simple "shows gross instead of net" bug. `GCashPayments.jsx` is unaffected — it doesn't
hardcode a status filter and defaults to showing all payments regardless of sale status.
**Client decision (2026-08-21): hold for a dedicated pass rather than bundle into this release.**
Fix, when picked up: `CashierSalesReport.jsx` must fetch `'adjusted'` sales alongside
`'completed'` (voided should stay excluded), and `receiptSalesUtils.js`'s
`summarizeSalesByProduct`/`summarizeSalesByProductFiltered` need per-(sale,product) refund netting
via the same `refundedUnitsBySaleAndProduct`-style join M1 already built for the two dashboards —
receipts as currently built (`receiptRecordFromCloudSale`/`receiptRecordFromSale`) carry no
per-product refund attribution, only the sale-level `refunded_amount`/`refunded_units` fields, so
this needs `sale_adjustments` plumbed into the receipt-fetch path in both `desktopApi.js` and
`server/index.js`, not just a one-line status-filter change.

**Two low-severity non-atomic Dexie write findings, tracked but not fixed this pass (cosmetic,
no money/stock risk):**
- `src/cashier-pos/offline/syncEngine.js:1042-1045,1133-1136` — `finalizeVoidedSaleUpload`/
  `uploadSale` delete the `pendingSales` row and update `completedSales` as two separate awaits,
  not one Dexie transaction (unlike the equivalent paths in `saleRepository.js`, which correctly
  wrap these). If interrupted between the two, a sale's local "still syncing" badge can get stuck
  even though the cloud write already succeeded — a display-only staleness, not a money/stock
  risk, since the cloud write itself already completed by that point.
- `src/admin-page/offline/syncEngine.js:690-723` — the `deleteProduct` op handler's product
  write and `pendingOps.delete()` aren't wrapped in a transaction either. Low risk: retrying the
  op after an interruption just repeats the same idempotent delete/archive branch.

`npm run test:offline` is 275/275 as of this pass's commits (`ccd828a`, `7edf3aa`); `npm run
test:vercel` unaffected. `npm run build` and `npm run build:cashier` both clean.

---

## Live-support fixes, 2026-08-21/22 (client-reported symptoms, not yet logged)

Four fixes landed in direct response to live client reports between the previous section and the
next audit pass below. Documented here for the record since they never got a register entry at
the time.

**M18. HIGH — ✅ FIXED. Stock Count silently froze a product's quantity forever once it accumulated
more than 50 lifetime stock movements.** `src/admin-page/offline/stockMovementReconciler.js`'s
`reconcileProductStock` fetched page 1 of `stock_movements` sorted **ascending** — once a product
passes the 50-record window size, page 1 of an ascending sort is the OLDEST page, not a recent
one, so every reconciliation silently anchored on a stale, frozen-in-time total and overwrote every
subsequent legitimate operation's correct quantity back to it. Confirmed live on production: every
one of MARLBORO RED ORIGINAL's 74 lifetime movements showed the same stale `previous_quantity`.
15 production products were found affected; the client chose to let the client re-run Stock Count
on each once fixed, rather than a batch correction script. Fix: fetch descending
(`-created,-created_at`) and reverse before feeding into `stockQuantityFromMovements`. Commit
`c615f10`.

**M19. HIGH — ✅ FIXED. A physical Stock Count was folded as a delta instead of an absolute value,
so duplicate/retried count attempts compounded instead of converging.** Symptom: entering "1600"
during a Stock Count on Marlboro Red Original showed 0 pieces, then 1589 on a retry with the same
input — this was a second, independent bug exposed once M18's fix let a backlog of stale queued
ops finally drain. `src/admin-page/offline/syncEngine.js`'s `adjustInventoryCount` handler computed
`previousQuantity + delta` at apply time instead of using the op's own `countedQty` (an absolute
target, not a relative adjustment) — several queued/duplicate count attempts, each computed against
a possibly-stale baseline, compounded (1600 → 908 → 216) instead of all landing on 1600. Fix: apply
`countedQty` directly, both in the main op handler and in the pending-ops replay fold (new
`applyPendingStockOps` helper). New `tests/stock-count-absolute-application.test.js` (7 tests).
Commit `72983dc`.

**M20. HIGH — ✅ FIXED. Archived/deleted products could still be scanned, listed, and sold through
the web-mode (Express/Vercel) cashier routes.** `server/index.js`'s `findProductByScanBarcode`
fetched with no `lifecycle_status` field and no filtering at all; `GET /api/cashier/products`
returned every product unfiltered; `POST /api/cashier/sales` had no lifecycle check anywhere.
Fixed all three using the existing `isCatalogActive` helper (already used elsewhere in this same
file for dashboard stats per M10). This is the web-mode path only, used when running the server
directly rather than via Tauri; see M21 for the same class of gap in the desktop app. Commit
`ad9a4a6`.

**M21. HIGH — ✅ FIXED. Archived/deleted products could bypass the desktop cashier's own protection
by searching by name instead of scanning a barcode.** The barcode-scan path
(`desktopApi.js`'s `productByBarcode`) already correctly rejected an archived/deleted product, but
`Cashier.jsx`'s `filteredProducts` (the product-search-by-name dropdown) had zero lifecycle
filtering — the only protection against archived/deleted products entering a new transaction was
the barcode-scan path, and it was entirely bypassable by typing a name instead of scanning. This is
the real bug behind the client's continued reports even after M20 shipped, since both of their
terminals (POS-25A2EE, POS-72F1F2) run the Tauri desktop app, not the web-mode path. Fixed by
importing `isCatalogActive` into `Cashier.jsx` and filtering `filteredProducts`, plus a
defense-in-depth check in `handleAddToCart` (the single choke point every add-to-cart flow —
search, scan, Quick Add — funnels through, confirmed by exhaustively tracing every call site of
`openInitialQuantityPrompt`/`commitProductToCart`). Also fixed two related gaps in the cashier's
own `desktopApi.js` admin-cache-fallback lookups (`adminCachedProducts`, `adminCachedProductByBarcode`)
that checked only the legacy `deleted` boolean flag, not the modern `lifecycleStatus` field. Note:
this deliberately does NOT affect looking up a product in a past/historical sale (void, refund,
reprint) — that resolution path is intentionally not lifecycle-filtered per the existing M9/M10
design; this fix is only about preventing a NEW sale/scan/search from surfacing an archived/deleted
product. Commit `dfa0e04`.

`npm run test:offline` 283/283, `npm run test:vercel` 7/7, all three builds clean as of these four
commits.

---

## Re-audit pass, 2026-08-22 (fresh full-system scan, three parallel reviews)

Three parallel background audits (cashier checkout flow; admin/reporting parity between the Tauri
admin and web admin; offline-sync/Dexie layer), each explicitly scoped to skip everything already
covered above. Every finding below was independently re-verified against the actual pre-fix code
(via `git diff`) before being treated as real, not just taken on the audit agent's word.

**M22. MEDIUM — ✅ FIXED. Web admin dashboard's "data quality" warnings counted archived/deleted
products; the Tauri admin dashboard didn't.** `server/index.js`'s `GET /api/dashboard` route
correctly filters to `catalogProducts` (via `isCatalogActive`) for `currentStockUnits`,
`criticalStockProducts`, and `inventoryHealth` — matching M10's fix — but the `dataQuality` block
(generated-barcode count, uncategorized count, non-positive-price count) still filtered from the
raw, unfiltered `products` list. The Tauri admin's equivalent (`desktopApi.js`'s
`buildDashboardFromRecords`) already filtered correctly. Both surfaces feed the same shared
`Dashboard.jsx` "N data-quality warnings" banner, so the web admin's count was permanently inflated
by every archived/deleted product's stale data and disagreed with the desktop admin for the same
store. Cosmetic/diagnostic only — no money or stock impact. Fix: swap `products` for
`catalogProducts` in the three `dataQuality` lines.

**M23. MEDIUM — ✅ FIXED. Two terminals refunding the same sale around the same time could silently
lose one refund's contribution to the sale's reported totals.** `src/cashier-pos/offline/syncEngine.js`'s
`adjustCompletedSale`/`voidCompletedSale` handler computed
`nextRefundedAmount = sale.refunded_amount + payload.amount` from a single, non-atomic read of the
`sales` record — a classic read-modify-write race. If Terminal 1 and Terminal 2 each process a
different partial refund/exchange on the *same* sale within the same sync window, both read the
same pre-refund total and whichever write lands last silently overwrites the other's increment. The
`sale_adjustments` audit-trail record itself is unaffected (correctly deduped by `adjustment_id`),
but `sales.refunded_amount`/`refunded_units` — which `netSaleAmount`/`netSaleUnits` read directly,
feeding every dashboard and report — permanently overstates net revenue by the lost amount, with no
self-healing (unlike stock, which `reconcileProductStock` already recomputes from the
`stock_movements` ledger). Needs two genuinely concurrent refund actions on the same sale from
different terminals to trigger — narrow but real, and undetectable once it happens.
Fix: recompute `refunded_amount`/`refunded_units` as the sum over the full `sale_adjustments`
ledger for that sale (fetched fresh) rather than incrementing the stale read — mirrors
`reconcileProductStock`'s recompute-from-ledger approach. This also means any *later* refund on the
same sale self-corrects a prior drift, since it resums the whole ledger. New test in
`tests/sale-adjustment-cloud-sync.test.js` ("two concurrent refunds on the same sale both land
instead of one clobbering the other") reproduces the exact race pre-fix and passes post-fix.

**S10. MEDIUM — ✅ FIXED. The `process_sales` staff capability was enforced only in the checkout
UI, not in the function that actually records a sale.** `Cashier.jsx`'s `openPaymentFlow` correctly
blocks checkout via `can('process_sales')`, but `saleRepository.js`'s `finalizeSaleLocally` (the
function `cashierApi.completeSale` actually calls) had no equivalent check — unlike void/refund/
exchange, which are independently gated by mandatory manager approval regardless of the UI
capability check. A cashier account with `process_sales` explicitly excluded from its permissions
(e.g. a restricted trainee account) could still complete a sale by invoking the underlying function
directly. Note: on this offline-first desktop app, no client-side check can fully close a
determined devtools-console bypass (the terminal itself has full script execution) — this fix
closes the accidental/incidental gap (any future code path that calls `finalizeSaleLocally`
directly without going through the UI's gate) and matches this codebase's established
defense-in-depth pattern of checking critical rules at more than one layer, the same way
archived-product exclusion is checked at multiple layers (M20/M21). A true server-side-enforced
permission system would require PocketBase API-rule changes, a separate, larger design question.
Fix: `Cashier.jsx` now passes the cashier's `permissions` array through to `completeSale`;
`validateSale` rejects the sale if `process_sales` is explicitly excluded, using the same
default-full-access convention as `can()` (empty/missing permissions = unrestricted).

**M24. MEDIUM — ✅ FIXED. A fully-discounted (₱0.00) sale could not actually be completed.** The
discount modal explicitly allows a manager-approved 100% discount (or a peso discount equal to the
full subtotal) — a real, reachable flow (senior/PWD + promo stacking, an employee freebie, a
documented damaged-goods write-off) — but nothing checked for a zero total until the very last
step: `validateSale` rejected any sale whose total wasn't strictly greater than zero, so the
cashier could go through the entire payment flow only to have it fail at the end with a raw,
unexplained error, with no way to actually record the transaction. Fix: `validateSale` (desktop)
and the twin check in `server/index.js`'s `POST /api/cashier/sales` (web-mode) now only reject a
**negative** total, not a zero one.

**Also reviewed this pass, no new issues found:** `salesByCashier`/`getSalesByCashier` netting
parity; GCash payment mapping on both surfaces; FSN metrics' deliberate non-filtering of archived
products (consistent with M10's documented scope); manager/void-barcode approval enforcement across
routes; every other `getList(1, N, ...)` pagination call in both offline directories (none share
M18's ascending-sort bug); every Dexie table's declared primary key against every call site in both
apps (none share T4's key-mismatch bug); non-atomic multi-step Dexie writes (no new gaps beyond the
two already tracked above); sync-tick concurrency (both engines correctly single-flight).

`npm run test:offline` 289/289, `npm run test:vercel` 7/7, all three builds (`build`,
`build:cashier`, `build:vercel`) clean as of this pass.
