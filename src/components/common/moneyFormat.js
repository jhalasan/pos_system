// Groups the integer part of a raw numeric string with thousands commas,
// leaving the decimal part (including a trailing bare ".") untouched so it
// stays legible mid-typing without forcing digits the cashier hasn't typed yet.
export function formatMoneyDisplay(raw) {
  const str = String(raw ?? '');
  if (str === '') return '';
  const dotIndex = str.indexOf('.');
  const intPart = dotIndex === -1 ? str : str.slice(0, dotIndex);
  const decPart = dotIndex === -1 ? '' : str.slice(dotIndex);
  const digitsOnly = intPart.replace(/[^0-9]/g, '');
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${decPart}`;
}

// Strips commas/invalid characters back down to a plain numeric string
// (digits, at most one ".", at most 2 decimal places) — the same shape every
// existing amount field already stores and calls Number()/toFixed(2) on.
export function cleanMoneyInput(raw) {
  let cleaned = String(raw ?? '').replace(/,/g, '').replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
    const [intPart, decPart = ''] = cleaned.split('.');
    if (decPart.length > 2) cleaned = `${intPart}.${decPart.slice(0, 2)}`;
  }
  return cleaned;
}
