import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getInventoryBreakdown,
  getInventoryRemainderBreakdown,
  breakdownUnitLabel,
} from '../src/utils/inventoryBreakdown.js';

// Fixtures below are the real production shapes pulled from PocketBase while
// investigating a client-reported "0.155 Sack" / "0.008 Pieces" bug in the
// Product Management unit breakdown -- see POS_AUDIT_REGISTER.md and
// docs/superpowers/plans/2026-08-27-product-breakdown-whole-units.md.

function sugarBrown(qty) {
  return {
    qty,
    unit: 'Kilogram',
    allowFractional: true,
    purchaseUnit: 'Sack',
    conversionQuantity: 50,
    sellingUnits: [
      { barcode: '2964278131286', unit: 'Kilogram', conversion: 1, price: 65 },
      { barcode: '', unit: '1/4 KILO', conversion: 0.25, price: 17 },
      { barcode: '', unit: '1/2 KILO', conversion: 0.5, price: 33 },
    ],
    price: 65,
  };
}

function sugarWhite(qty) {
  return {
    qty,
    unit: 'Kilogram',
    allowFractional: true,
    purchaseUnit: 'Sack',
    conversionQuantity: 50,
    sellingUnits: [
      { barcode: '2964283174368', unit: 'Kilogram', conversion: 1, price: 80 },
      { barcode: '', unit: '1/4 KILO', conversion: 0.25, price: 20 },
      { barcode: '', unit: '1/2 KILO', conversion: 0.5, price: 40 },
    ],
    price: 80,
  };
}

function mismoCoke({ fractional = true } = {}) {
  return {
    qty: 20,
    unit: 'Piece',
    allowFractional: fractional,
    purchaseUnit: 'CASE',
    conversionQuantity: 12,
    sellingUnits: [
      { barcode: 'RELEASED-7l2h6avb6cbnsj1-0', unit: 'Piece', conversion: 1, price: 20 },
      { barcode: '', unit: 'CASE', conversion: 12, price: 200 },
    ],
    price: 20,
  };
}

function litroCoke({ fractional = false } = {}) {
  return {
    qty: 162,
    unit: 'Piece',
    allowFractional: fractional,
    purchaseUnit: 'CASE',
    conversionQuantity: 12,
    sellingUnits: [
      { barcode: '2947004037246', unit: 'Piece', conversion: 1, price: 33.33 },
      { barcode: '2947011047881', unit: 'CASE', conversion: 12, price: 400 },
      { barcode: '', unit: 'HALF CASE', conversion: 6, price: 200 },
    ],
    price: 33.33,
  };
}

function kasaloCoke({ fractional = false } = {}) {
  return {
    qty: 104,
    unit: 'Piece',
    allowFractional: fractional,
    purchaseUnit: 'CASE',
    conversionQuantity: 12,
    sellingUnits: [
      { barcode: '2947006712363', unit: 'Piece', conversion: 1, price: 23.75 },
      { barcode: '', unit: 'CASE', conversion: 12, price: 285 },
      { barcode: '', unit: 'HALF CASE', conversion: 6, price: 142.5 },
    ],
    price: 23.75,
  };
}

function eightOzCoke({ fractional = false } = {}) {
  return {
    qty: 1992,
    unit: 'Piece',
    allowFractional: fractional,
    purchaseUnit: 'case',
    conversionQuantity: 24,
    sellingUnits: [
      { barcode: '2946977580100', unit: 'Piece', conversion: 1, price: 8.625 },
      { barcode: '', unit: 'case', conversion: 24, price: 207 },
      { barcode: '', unit: 'HALF CASE', conversion: 12, price: 103.5 },
    ],
    price: 8.625,
  };
}

function countsByUnit(rows) {
  const map = {};
  for (const row of rows) map[row.unit] = row.count;
  return map;
}

test('SUGAR BROWN 7.75kg breaks down into whole units summing back exactly', () => {
  const rows = getInventoryRemainderBreakdown(sugarBrown(7.75));
  const counts = countsByUnit(rows);
  assert.equal(counts.Sack, 0);
  assert.equal(counts.Kilogram, 7);
  assert.equal(counts['1/2 KILO'], 1);
  assert.equal(counts['1/4 KILO'], 1);
  const sum = rows.reduce((total, row) => total + row.count * row.conversion, 0);
  assert.equal(sum, 7.75);
});

test('SUGAR WHITE 44.75kg breaks down into whole units', () => {
  const counts = countsByUnit(getInventoryRemainderBreakdown(sugarWhite(44.75)));
  assert.equal(counts.Sack, 0);
  assert.equal(counts.Kilogram, 44);
  assert.equal(counts['1/2 KILO'], 1);
  assert.equal(counts['1/4 KILO'], 1);
});

test('MISMO COKE (fractional, qty 20) breaks down into 1 CASE + 8 Pieces, not 1.666 CASE', () => {
  const counts = countsByUnit(getInventoryRemainderBreakdown(mismoCoke({ fractional: true })));
  assert.equal(counts.CASE, 1);
  assert.equal(counts.Piece, 8);
});

test('a non-fractional sack-conversion product still breaks down correctly (unaffected by the fix)', () => {
  const product = {
    qty: 137,
    unit: 'Piece',
    allowFractional: false,
    purchaseUnit: 'Sack',
    conversionQuantity: 50,
    sellingUnits: [
      { barcode: '', unit: 'Piece', conversion: 1, price: 5 },
    ],
    price: 5,
  };
  const counts = countsByUnit(getInventoryRemainderBreakdown(product));
  assert.equal(counts.Sack, 2);
  assert.equal(counts.Piece, 37);
});

test('real discrete Coke fixtures produce the same whole counts the current code already gets right', () => {
  assert.deepEqual(countsByUnit(getInventoryRemainderBreakdown(eightOzCoke())), {
    case: 83,
    'HALF CASE': 0,
    Piece: 0,
  });
  assert.deepEqual(countsByUnit(getInventoryRemainderBreakdown(litroCoke())), {
    CASE: 13,
    'HALF CASE': 1,
    Piece: 0,
  });
  assert.deepEqual(countsByUnit(getInventoryRemainderBreakdown(kasaloCoke())), {
    CASE: 8,
    'HALF CASE': 1,
    Piece: 2,
  });
});

test('allow_fractional independence: flipping the flag never changes the whole-number breakdown', () => {
  for (const [buildDiscrete, buildFractional] of [
    [litroCoke, () => litroCoke({ fractional: true })],
    [kasaloCoke, () => kasaloCoke({ fractional: true })],
  ]) {
    const discreteCounts = countsByUnit(getInventoryRemainderBreakdown(buildDiscrete()));
    const fractionalCounts = countsByUnit(getInventoryRemainderBreakdown(buildFractional()));
    assert.deepEqual(fractionalCounts, discreteCounts);
  }
});

test('an odd remainder floors instead of showing a decimal (documented under-report trade-off)', () => {
  const product = sugarBrown(7.8);
  const counts = countsByUnit(getInventoryRemainderBreakdown(product));
  assert.equal(counts.Kilogram, 7);
  assert.equal(counts['1/2 KILO'], 1);
  assert.equal(counts['1/4 KILO'], 1);
  // Never a decimal anywhere in the breakdown.
  for (const row of getInventoryRemainderBreakdown(product)) {
    assert.ok(Number.isInteger(row.count), `${row.unit} count ${row.count} is not a whole number`);
  }
});

test('float-drift-prone quantities still resolve to exact whole counts via the toMillis path', () => {
  const product = {
    qty: 0.3, // 0.1 + 0.2 in floating point is 0.30000000000000004
    unit: 'Kilogram',
    allowFractional: true,
    sellingUnits: [
      { unit: 'Kilogram', conversion: 0.1, price: 10 },
    ],
  };
  const counts = countsByUnit(getInventoryRemainderBreakdown(product));
  assert.equal(counts.Kilogram, 3);
});

test('a sub-precision conversion is skipped rather than causing a divide-by-zero', () => {
  const product = {
    qty: 5,
    unit: 'Kilogram',
    allowFractional: true,
    sellingUnits: [
      { unit: 'Kilogram', conversion: 1, price: 10 },
      { unit: 'Dust', conversion: 0.0001, price: 0 },
    ],
  };
  const rows = getInventoryRemainderBreakdown(product);
  assert.ok(rows.every((row) => row.unit !== 'Dust'));
  assert.equal(countsByUnit(rows).Kilogram, 5);
});

test('zero stock reports every unit at zero', () => {
  const counts = countsByUnit(getInventoryRemainderBreakdown(sugarBrown(0)));
  assert.equal(counts.Sack, 0);
  assert.equal(counts.Kilogram, 0);
  assert.equal(counts['1/2 KILO'], 0);
  assert.equal(counts['1/4 KILO'], 0);
});

test('getInventoryBreakdown reports whole per-unit capacity regardless of the fractional flag', () => {
  const discrete = getInventoryBreakdown(kasaloCoke());
  const fractional = getInventoryBreakdown(kasaloCoke({ fractional: true }));
  const byUnit = (rows) => Object.fromEntries(rows.map((row) => [row.unit, row.total]));
  assert.deepEqual(byUnit(fractional), byUnit(discrete));
  assert.equal(byUnit(discrete).CASE, 8);
});

test('breakdownUnitLabel uses the selling unit\'s own name, not the product\'s base unit', () => {
  const product = sugarBrown(7.75);
  const halfKilo = { unit: '1/2 KILO', conversion: 0.5, count: 1 };
  const quarterKilo = { unit: '1/4 KILO', conversion: 0.25, count: 1 };
  const sack = { unit: 'Sack', conversion: 50, count: 2 };
  assert.equal(breakdownUnitLabel(product, halfKilo), '1/2 KILO (L)');
  assert.equal(breakdownUnitLabel(product, quarterKilo), '1/4 KILO (L)');
  assert.equal(breakdownUnitLabel(product, sack), 'Sack (F)');
});
