const RECEIPT_WIDTH = 32
const DEFAULT_PRINTER_NAME = 'XP-58H'
const DEFAULT_COPY_COUNT = 2

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
}

function envNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function moneyValue(value) {
  return Number(value || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function barcodeLine(value) {
  const code = cleanText(value).replace(/[^A-Za-z0-9._-]/g, '')
  return code ? `{{BARCODE:${code}}}` : ''
}

function line(char = '-') {
  return char.repeat(RECEIPT_WIDTH)
}

function center(text = '') {
  const value = cleanText(text).slice(0, RECEIPT_WIDTH)
  const left = Math.max(0, Math.floor((RECEIPT_WIDTH - value.length) / 2))
  return `${' '.repeat(left)}${value}`
}

function columns(left, right) {
  const rightText = cleanText(right)
  const availableLeft = Math.max(0, RECEIPT_WIDTH - rightText.length - 1)
  const leftText = cleanText(left).slice(0, availableLeft)
  return `${leftText}${' '.repeat(Math.max(1, RECEIPT_WIDTH - leftText.length - rightText.length))}${rightText}`
}

function itemLines(item) {
  const name = cleanText(item.name || 'Item')
  const quantity = Number(item.quantity) || 0
  const price = Number(item.price) || 0
  const total = quantity * price
  return [
    name.slice(0, RECEIPT_WIDTH),
    columns(`${quantity} x ${moneyValue(price)}`, moneyValue(total)),
  ]
}

function paymentRows(payment = {}) {
  if (payment.paymentMethod === 'split') {
    const cash = Number(payment.splitPayments?.cash) || 0
    const gcash = Number(payment.splitPayments?.gcash) || 0
    const gcashRef = payment.splitPayments?.gcashRef
    const paid = cash + gcash
    return [
      columns('Payment', 'Split'),
      columns('Cash', moneyValue(cash)),
      columns('GCash', moneyValue(gcash)),
      gcashRef ? columns('GCash Ref', gcashRef) : '',
      columns('Paid', moneyValue(paid)),
      columns('Change', moneyValue(Math.max(0, paid - Number(payment.totalAmount || 0)))),
    ].filter(Boolean)
  }

  if (payment.paymentMethod === 'gcash') {
    const gcashAmount = Number(payment.gcashAmount) || Number(payment.totalAmount) || 0
    return [
      columns('Payment', 'GCash'),
      columns('GCash Amount', moneyValue(gcashAmount)),
      payment.gcashRef ? columns('Ref', payment.gcashRef) : '',
    ].filter(Boolean)
  }

  const cashAmount = Number(payment.cashAmount) || Number(payment.totalAmount) || 0
  const change = Number(payment.change)

  return [
    columns('Payment', 'Cash'),
    columns('Cash', moneyValue(cashAmount)),
    columns('Change', moneyValue(Math.max(0, Number.isFinite(change) ? change : cashAmount - Number(payment.totalAmount || 0)))),
  ]
}

export function buildReceiptText({ copyLabel, transactionNo, cashierName, completedAt, items, payment }) {
  const itemCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  const subtotal = Number(payment.subtotalAmount) || 0
  const discountPercent = Number(payment.discountPercent) || 0
  const discountAmount = Number(payment.discountAmount) || 0
  const total = Number(payment.totalAmount) || 0
  const completedDate = completedAt ? new Date(completedAt) : new Date()

  return [
    center('NEXA POS'),
    center('Sales Receipt'),
    center(copyLabel),
    line(),
    columns('Txn', transactionNo),
    columns('Date', completedDate.toLocaleString('en-PH')),
    columns('Cashier', cashierName || 'Cashier'),
    line(),
    ...items.flatMap(itemLines),
    line(),
    columns('Items', itemCount),
    columns('Subtotal', moneyValue(subtotal)),
    discountPercent > 0 ? columns(`Discount ${discountPercent}%`, `-${moneyValue(discountAmount)}`) : '',
    columns('TOTAL', moneyValue(total)),
    line(),
    ...paymentRows(payment),
    line(),
    center('Scan for lookup'),
    barcodeLine(transactionNo),
    line(),
    center('Thank you!'),
    '\n\n\n',
  ].filter(Boolean).join('\n')
}

function buildPrintableHtml(receipts) {
  const escaped = receipts
    .map((receipt) => String(receipt)
      .replace(/\{\{BARCODE:([^}]+)\}\}/g, '*$1*')
      .replace(/[&<>]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
    }[char])))
    .join('\n\n')

  return `<!doctype html>
<html>
<head>
  <title>Receipt</title>
  <style>
    @page { size: 58mm auto; margin: 3mm; }
    body { margin: 0; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; }
  </style>
</head>
<body>${escaped}<script>window.onload = () => { window.print(); window.close(); };</script></body>
</html>`
}

function receiptTexts(receiptData, options = {}) {
  const copies = envNumber(import.meta.env.VITE_RECEIPT_COPIES, DEFAULT_COPY_COUNT)
  const labels = options.copyLabels || ['Customer Copy', 'Store Copy'].slice(0, copies)
  return labels.map((copyLabel, index) => buildReceiptText({
    ...receiptData,
    copyLabel: copyLabel || `Copy ${index + 1}`,
  }))
}

function printWithBrowser(receipts, windowName = 'receipt-print') {
  const popup = window.open('', windowName, 'width=360,height=640')
  if (!popup) throw new Error('Receipt popup was blocked.')
  popup.document.open()
  popup.document.write(buildPrintableHtml(receipts))
  popup.document.close()
}

function pdfEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function pdfObject(id, body) {
  return `${id} 0 obj\n${body}\nendobj\n`
}

function buildReceiptPdf(receipts) {
  const pages = []
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
  ]
  const pageRefs = []
  const fontId = 3 + (receipts.length * 2)
  let nextObjectId = 3

  for (const receipt of receipts) {
    const lines = String(receipt)
      .replace(/\{\{BARCODE:([^}]+)\}\}/g, 'BARCODE: $1')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
    const pageHeight = Math.max(300, (lines.length * 10) + 40)
    const content = [
      'BT',
      '/F1 8 Tf',
      '10 TL',
      `10 ${pageHeight - 20} Td`,
      ...lines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      'ET',
    ].join('\n')
    const pageId = nextObjectId++
    const contentId = nextObjectId++
    pageRefs.push(`${pageId} 0 R`)
    pages.push(pdfObject(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 164 ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
    pages.push(pdfObject(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
  }

  objects.push(pdfObject(2, `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`))
  objects.push(...pages)
  objects.push(pdfObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'))

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(pdf.length)
    pdf += object
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return pdf
}

function receiptPdfFilename(receiptData, copyLabels = []) {
  const transactionNo = String(receiptData.transactionNo || 'receipt').replace(/[^A-Za-z0-9_-]/g, '-')
  const label = String(copyLabels[0] || 'receipt').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${transactionNo}-${label || 'receipt'}.pdf`
}

function downloadPdf(filename, contents) {
  const blob = new Blob([contents], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function printCompletedReceipt(receiptData, options = {}) {
  const printerName = import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME
  const receipts = receiptTexts(receiptData, options)
  const invoke = tauriInvoke()

  if (invoke) {
    const contents = receipts.join('\n')
    try {
      return await invoke('print_receipt', {
        printerName,
        contents,
        copies: 1,
      })
    } catch (error) {
      const message = typeof error === 'string' ? error : error?.message || ''
      if (printerName && /deleted|1905|open printer/i.test(message)) {
        return invoke('print_receipt', {
          printerName: '',
          contents,
          copies: 1,
        })
      }
      throw error
    }
  }

  printWithBrowser(receipts)
  return { printerName: 'browser print dialog', copies: receipts.length }
}

export async function printReceiptPdf(receiptData, options = {}) {
  const receipts = receiptTexts(receiptData, options)
  const pdf = buildReceiptPdf(receipts)
  const filename = options.filename || receiptPdfFilename(receiptData, options.copyLabels)
  const directory = String(options.directory || '').trim()
  const invoke = tauriInvoke()

  if (invoke && directory) {
    const path = await invoke('write_export_file', {
      directory,
      filename,
      contents: pdf,
    })
    return { path, method: 'file', copies: receipts.length }
  }

  downloadPdf(filename, pdf)
  return { path: filename, method: 'download', copies: receipts.length }
}
