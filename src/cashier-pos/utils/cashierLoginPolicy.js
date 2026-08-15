// This only ever rejected an empty/whitespace-only value -- its previous
// name, allowsCashierBarcodeLogin, implied a real policy gate (format
// validation, an allow-list, a rate limit) that never existed. The actual
// authority is the server: POST /api/cashier/auth/barcode looks the scanned
// value up against real accounts and rejects anything that doesn't match.
// This function is only a client-side "don't bother the network with an
// empty field" pre-check.
export function isBarcodeProvided(barcode = '') {
  return String(barcode || '').trim().length > 0;
}
