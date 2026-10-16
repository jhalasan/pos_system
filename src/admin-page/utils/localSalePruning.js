// Decides whether a LOCAL completedSales row may be deleted after the admin
// reconciles receipts against a cloud window (fetchReceiptRecords).
//
// completedSales is the authoritative local source for an open shift's Cash /
// GCash Sales (getShiftLedgerTotals), so deleting a row that is actually fine
// makes that shift's expected cash read low. "Not in the window I just loaded"
// is NOT evidence a row is gone -- so a row is only pruned when it:
//   - is not waiting to sync, and not present in the cloud result;
//   - is dated INSIDE the window that was loaded (a row outside it was never
//     checked against the cloud at all);
//   - is not very recent (the cloud list can be a few seconds older than the
//     pending-queue read; a sale uploaded in between would look absent);
//   - has a readable date (unknown age: leave it alone).
export const PRUNE_MIN_AGE_MS = 30 * 60 * 1000

export function shouldPruneLocalCompletedSale(sale, {
  pendingIds,
  pendingTransactionNos,
  cloudIds,
  cloudTransactionNos,
  fromISO,
  toISO,
  now = Date.now(),
}) {
  if (pendingIds.has(String(sale.clientSaleId || ''))) return false
  if (pendingTransactionNos.has(String(sale.transactionNo || ''))) return false
  if (cloudIds.has(String(sale.clientSaleId || ''))) return false
  if (cloudTransactionNos.has(String(sale.transactionNo || ''))) return false

  const created = new Date(sale.createdAt).getTime()
  if (!Number.isFinite(created)) return false
  if (fromISO && created < new Date(fromISO).getTime()) return false
  if (toISO && created > new Date(toISO).getTime()) return false
  if (now - created < PRUNE_MIN_AGE_MS) return false
  return true
}
