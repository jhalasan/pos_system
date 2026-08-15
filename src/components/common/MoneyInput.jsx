import { useEffect, useRef } from 'react';
import Input from './Input';
import { formatMoneyDisplay, cleanMoneyInput } from './moneyFormat';

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
// eslint-disable-next-line no-unused-vars -- min/step destructured only to keep them off the underlying text input
export default function MoneyInput({ value, onChange, inputRef: externalRef, min, step, ...props }) {
  const nodeRef = useRef(null);
  const pendingCursorDigits = useRef(null);
  const displayValue = formatMoneyDisplay(value);

  const setRef = (node) => {
    nodeRef.current = node;
    if (typeof externalRef === 'function') externalRef(node);
    // eslint-disable-next-line react-hooks/immutability -- externalRef is a ref object (the `inputRef` prop convention used throughout this codebase), not a plain prop; merging forwarded refs by writing .current is the standard safe pattern.
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
      // eslint-disable-next-line react-hooks/immutability -- setRef merges the forwarded ref via the same safe .current write disabled above
      inputRef={setRef}
    />
  );
}
