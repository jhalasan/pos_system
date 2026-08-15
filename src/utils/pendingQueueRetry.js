// Shared by both admin and cashier desktopApi.js: a manual "Sync" click
// used to wipe every queued row's `attempts` back to 0 alongside resetting
// `nextAttemptAt`. That defeats the whole point of the attempts counter —
// an op that had already burned 9 of its 10 attempts (and was one failure
// away from being dead-lettered so someone could actually see and deal with
// it) gets fully resurrected by a manual sync click and takes another 10
// failures to reach that point again. A manual sync click should make
// eligible rows retry now, not erase their failure history.
//
// This only ever touches `status` (failed -> pending, so the row is
// eligible again) and `nextAttemptAt` (cleared only when it is genuinely
// far out — more than 60s away — so a row that's already about to fire
// naturally, or one in an active rate-limit cooldown protecting PocketHost,
// is left alone). `attempts` is never modified.
export async function forceRetryNow(table, { statuses = ['pending', 'failed'] } = {}) {
  const now = Date.now()
  const rows = await table.where('status').anyOf(statuses).toArray()

  for (const row of rows) {
    const patch = {}
    if (row.status === 'failed') patch.status = 'pending'
    if ((Number(row.nextAttemptAt) || 0) > now + 60_000) patch.nextAttemptAt = now
    if (Object.keys(patch).length > 0) await table.update(row.id, patch)
  }
}
