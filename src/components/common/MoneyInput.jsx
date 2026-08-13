import { useEffect, useRef } from 'react';
import Input from './Input';

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

function digitsBefore(str, pos) {
  return str.slice(0, pos).replace(/,/g, '').length;
}

function cursorForDigitCount(formatted, digitCount) {
  if (digitCount <= 0) return 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (formatted[i] !== ',') {
      count += 1;
      if (count === digitCount) return i + 1;
    }
  }
  return formatted.length;
}

// Drop-in replacement for a money <Input type="number">: same value/onChange
// contract (onChange receives {target: {value: <plain numeric string>}}), so
// every existing handler (setXxx(e.target.value), Number(xxx), .toFixed(2))
// keeps working unchanged. Only the on-screen display gains thousands commas.
export default function MoneyInput({ value, onChange, inputRef: externalRef, min, step, ...props }) {
  const nodeRef = useRef(null);
  const pendingCursorDigits = useRef(null);
  const displayValue = formatMoneyDisplay(value);

  const setRef = (node) => {
    nodeRef.current = node;
    if (typeof externalRef === 'function') externalRef(node);
    else if (externalRef) externalRef.current = node;
  };

  useEffect(() => {
    if (pendingCursorDigits.current == null) return;
    const node = nodeRef.current;
    if (node) {
      const pos = cursorForDigitCount(displayValue, pendingCursorDigits.current);
      node.setSelectionRange(pos, pos);
    }
    pendingCursorDigits.current = null;
  }, [displayValue]);

  const handleChange = (e) => {
    const rawInput = e.target.value;
    const cursorPos = e.target.selectionStart ?? rawInput.length;
    pendingCursorDigits.current = digitsBefore(rawInput, cursorPos);
    onChange({ target: { value: cleanMoneyInput(rawInput) } });
  };

  return (
    <Input
      {...props}
      type="text"
      inputMode="decimal"
      value={displayValue}
      onChange={handleChange}
      inputRef={setRef}
    />
  );
}
