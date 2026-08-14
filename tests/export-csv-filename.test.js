import assert from 'node:assert/strict'
import test from 'node:test'
import { safeFilenamePart } from '../src/admin-page/utils/exportCsv.js'

test('safeFilenamePart strips unsafe characters', () => {
  assert.equal(safeFilenamePart('Arlie Velasco / Cashier #1'), 'Arlie-Velasco-Cashier-1')
})

test('safeFilenamePart collapses repeated separators and trims edges', () => {
  assert.equal(safeFilenamePart('  --weird//name--  '), 'weird-name')
})

test('safeFilenamePart falls back to "transaction" for empty input', () => {
  assert.equal(safeFilenamePart(''), 'transaction')
  assert.equal(safeFilenamePart(undefined), 'transaction')
})
