/// <reference path="../pb_data/types.d.ts" />

// Nexa POS -- cashier barcode login that runs on the store's own PocketBase,
// so it works whenever the local network works, with or without internet.
//
// Why this exists: the original barcode login is verified by the Vercel API
// (server/index.js, POST /api/cashier/auth/barcode). When the store's internet
// (or Vercel) is down, a terminal could not verify the barcode, silently fell
// back to an old saved session that had already expired, and then stopped
// uploading every sale until someone signed in with an email and password.
// Sales and syncing only ever need the LAN server, so the login that unlocks
// them should not depend on the internet either.
//
// What it does: finds the active cashier whose void_barcode matches and returns
// a normal PocketBase session for that account (7 days by the users
// collection's authToken setting, and renewable with authRefresh -- unlike the
// 12-hour impersonation token the Vercel route issues). The response shape
// matches the Vercel route: { ok: true, user: { ...record, token } }.
//
// Safety: the same account rules as the Vercel route (role cashier, not
// inactive; managers are never matched); a limit of 8 failed attempts per 5
// minutes per client IP (answered with 403, see below); and a database error is
// answered with a 500 -- never with the 401 "Invalid cashier barcode", which
// terminals treat as a final "this barcode does not exist".
//
// Deploy: copy this file into the `pb_hooks` folder next to the PocketBase
// executable and restart PocketBase (see pocketbase/README.md).

routerAdd("POST", "/api/nexa/barcode-login", (e) => {
  // Handlers run in isolated JS VMs: constants must live inside the handler.
  const MAX_FAILURES = 8
  const WINDOW_MS = 5 * 60 * 1000

  const body = e.requestInfo().body || {}
  const barcode = String(body.barcode || "").trim()
  if (!barcode) {
    return e.json(400, { error: "Cashier barcode is required." })
  }

  const store = $app.store()
  const limitKey = "nexaBarcodeLoginFailures:" + (e.realIP() || "unknown")
  const now = Date.now()
  let failures = []
  try {
    failures = JSON.parse(store.get(limitKey) || "[]").filter((at) => now - at < WINDOW_MS)
  } catch (_) {
    failures = []
  }
  if (failures.length >= MAX_FAILURES) {
    // 403, not 429: the terminal app arms a shared "PocketBase is rate limiting
    // us" pause on any 429 (pacedPocketBase.js), which would stall syncing on
    // that computer just because of a few mistaken scans at the login screen.
    return e.json(403, { error: "Too many attempts. Try again in a few minutes." })
  }

  let user = null
  try {
    user = $app.findFirstRecordByFilter(
      "users",
      "void_barcode = {:barcode} && role = 'cashier' && status != 'inactive'",
      { barcode: barcode },
    )
  } catch (err) {
    // Only "no matching row" means the barcode is not valid. Any other failure
    // (database busy/locked, ...) must surface as a server error instead.
    if (!/no rows/i.test(String(err))) {
      throw err
    }
  }

  if (!user) {
    failures.push(now)
    store.set(limitKey, JSON.stringify(failures))
    return e.json(401, { error: "Invalid cashier barcode." })
  }

  const token = user.newAuthToken()

  // Same audit trail as the Vercel route, so a barcode login that was verified
  // by the server always leaves a server-side "Signed in ... using barcode" row.
  try {
    const logs = $app.findCollectionByNameOrId("activity_logs")
    const log = new Record(logs)
    log.set("user_id", user.id)
    log.set("action_type", "Login")
    log.set("description", "Signed in to cashier POS using barcode")
    log.set("timestamp", new Date().toISOString())
    $app.save(log)
  } catch (err) {
    console.log("nexa barcode-login: could not write the activity log: " + err)
  }

  // The terminal needs the cashier's own email (hidden unless emailVisibility
  // is on); the password hash and token key are never part of publicExport().
  user.ignoreEmailVisibility(true)
  const record = user.publicExport()
  record.token = token
  return e.json(200, { ok: true, user: record })
})
