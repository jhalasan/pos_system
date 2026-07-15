import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReceiptPdf } from '../src/cashier-pos/services/receiptPrinter.js'

test('receipt PDF has valid object offsets and a non-empty page', () => {
  const pdf = buildReceiptPdf(['RECEIPT 123\nCustomer: Jose\nTOTAL PHP 47.62'])
  assert.match(pdf, /^%PDF-1\.4/)
  assert.match(pdf, /\/Count 1/)
  assert.match(pdf, /%%EOF\n$/)

  const xrefOffset = Number(pdf.match(/startxref\n(\d+)/)?.[1])
  assert.equal(pdf.slice(xrefOffset, xrefOffset + 4), 'xref')

  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]))
  offsets.forEach((offset, index) => {
    assert.equal(pdf.slice(offset, offset + String(index + 1).length + 6), `${index + 1} 0 obj`)
  })
})

