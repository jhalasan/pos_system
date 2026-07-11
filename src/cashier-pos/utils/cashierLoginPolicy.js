export function allowsCashierBarcodeLogin(barcode = '') {
  const value = String(barcode || '').trim();
  if (!value) return false;
  return true;
}
