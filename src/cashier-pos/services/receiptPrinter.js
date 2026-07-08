const RECEIPT_WIDTH = 32
const DEFAULT_PRINTER_NAME = 'XP-58H'
const DEFAULT_COPY_COUNT = 1
const RECEIPT_SETTINGS_KEY = 'nexa_receipt_print_settings'
const STORE_NAME = 'ARJOV CONSUMER GOODS TRADING'
const STORE_ADDRESS_LINES = [
  'Aparente Street Ext.',
  'Purok Malakas Brgy. San Isidro',
  'General Santos City',
]
const REFUND_RETURN_POLICY_LINES = [
  'Refunds/returns accepted within',
  '24 hours from purchase only.',
  'Keep receipt for verification.',
]

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
}

function envNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function savedReceiptPrinterName() {
  try {
    const settings = JSON.parse(localStorage.getItem(RECEIPT_SETTINGS_KEY) || '{}')
    return String(settings.printerName || '').trim()
  } catch {
    return ''
  }
}

function receiptPrinterName(options = {}) {
  return String(options.printerName || savedReceiptPrinterName() || import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME).trim()
}

function savedReceiptSpacing() {
  try {
    const settings = JSON.parse(localStorage.getItem(RECEIPT_SETTINGS_KEY) || '{}')
    return {
      beforeLines: clampNumber(settings.receiptBeforeFeedLines, 0, 0, 8),
      afterLines: clampNumber(settings.receiptAfterFeedLines ?? settings.receiptFeedLines, 0, 0, 8),
    }
  } catch {
    return { beforeLines: 0, afterLines: 0 }
  }
}

function printerStatusMessage(status) {
  const messages = Array.isArray(status?.messages) ? status.messages : []
  const queueCount = Array.isArray(status?.jobs) ? status.jobs.length : 0
  const detail = messages.length ? messages.join(' ') : 'Printer is not ready.'
  return queueCount > 0 ? `${detail} Windows queue has ${queueCount} job(s).` : detail
}

export async function getReceiptPrinterStatus(options = {}) {
  const printerName = receiptPrinterName(options)
  const invoke = tauriInvoke()

  if (!invoke) {
    return {
      printerName: 'browser print dialog',
      isReady: true,
      status: 0,
      messages: [],
      jobs: [],
    }
  }

  return invoke('printer_status', { printerName })
}

async function assertReceiptPrinterReady(options = {}) {
  if (options.skipStatusCheck) return null
  const status = await getReceiptPrinterStatus(options)
  if (!status?.isReady) {
    throw new Error(printerStatusMessage(status))
  }
  return status
}

function moneyValue(value) {
  return Number(value || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function buildShiftCloseReceiptText({
  cashierName,
  openedAt,
  closedAt,
  openingAmount,
  cashSales,
  cashIn,
  cashOut,
  expectedCash,
  actualCash,
  variance,
  countMode,
  denominations = [],
}) {
  const openedDate = openedAt ? new Date(openedAt) : new Date()
  const closedDate = closedAt ? new Date(closedAt) : new Date()
  const breakdown = Array.isArray(denominations) ? denominations : []

  return [
    center(STORE_NAME),
    ...STORE_ADDRESS_LINES.map(center),
    center('SHIFT CLOSE REPORT'),
    line(),
    columns('Cashier', cashierName || 'Cashier'),
    columns('Opened', openedDate.toLocaleString('en-PH')),
    columns('Closed', closedDate.toLocaleString('en-PH')),
    line(),
    columns('Cash Beginning', moneyValue(openingAmount)),
    columns('Cash Sales', moneyValue(cashSales)),
    columns('Cash In', moneyValue(cashIn)),
    columns('Cash Out', moneyValue(cashOut)),
    columns('Expected Ending', moneyValue(expectedCash)),
    columns('Actual Cash Ending', moneyValue(actualCash)),
    columns('Variance', moneyValue(variance)),
    line(),
    center(`Count Mode: ${countMode === 'denomination' ? 'Denomination' : 'Manual'}`),
    ...breakdown.map((item) => columns(`${item.denomination} x ${item.count}`, moneyValue((Number(item.count) || 0) * Number(item.denomination || 0)))),
    line(),
    center('Thank you!'),
  ].filter(Boolean).join('\n')
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

export function buildReceiptText({ transactionNo, cashierName, completedAt, items, payment }) {
  const itemCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  const subtotal = Number(payment.subtotalAmount) || 0
  const discountPercent = Number(payment.discountPercent) || 0
  const discountAmount = Number(payment.discountAmount) || 0
  const total = Number(payment.totalAmount) || 0
  const completedDate = completedAt ? new Date(completedAt) : new Date()

  return [
    center(STORE_NAME),
    ...STORE_ADDRESS_LINES.map(center),
    center('Sale Receipt'),
    line(),
    columns('Receipt No.', transactionNo),
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
    ...REFUND_RETURN_POLICY_LINES.map(center),
    line(),
    center('NOT AN OFFICIAL RECEIPT'),
    center('Thank you!'),
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
    .join('\n')

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
  return Array.from({ length: copies }, () => buildReceiptText(receiptData))
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
  const printerName = receiptPrinterName(options)
  const receipts = receiptTexts(receiptData, options)
  const openCashDrawer = Boolean(options.openCashDrawer)
  const spacing = savedReceiptSpacing()
  const beforeFeedLines = clampNumber(options.beforeFeedLines ?? spacing.beforeLines, 0, 0, 8)
  const afterFeedLines = clampNumber(options.afterFeedLines ?? spacing.afterLines, 0, 0, 8)
  const documentName = options.documentName || `Receipt ${receiptData?.transactionNo || ''}`.trim()
  const invoke = tauriInvoke()

  if (invoke) {
    await assertReceiptPrinterReady({ ...options, printerName })
    const contents = receipts.join('\n')
    try {
      return await invoke('print_receipt', {
        printerName,
        contents,
        copies: 1,
        openCashDrawer,
        documentName,
        beforeFeedLines,
        afterFeedLines,
      })
    } catch (error) {
      const message = typeof error === 'string' ? error : error?.message || ''
      if (printerName && /deleted|1905|open printer/i.test(message)) {
        return invoke('print_receipt', {
          printerName: '',
          contents,
          copies: 1,
          openCashDrawer,
          documentName,
          beforeFeedLines,
          afterFeedLines,
        })
      }
      throw error
    }
  }

  printWithBrowser(receipts)
  return { printerName: 'browser print dialog', copies: receipts.length }
}

export async function printShiftCloseReceipt(shiftCloseData, options = {}) {
  const printerName = receiptPrinterName(options)
  const contents = buildShiftCloseReceiptText(shiftCloseData)
  const spacing = savedReceiptSpacing()
  const beforeFeedLines = clampNumber(options.beforeFeedLines ?? spacing.beforeLines, 0, 0, 8)
  const afterFeedLines = clampNumber(options.afterFeedLines ?? spacing.afterLines, 0, 0, 8)
  const invoke = tauriInvoke()

  if (invoke) {
    await assertReceiptPrinterReady({ ...options, printerName })
    try {
      return await invoke('print_receipt', {
        printerName,
        contents,
        copies: 1,
        openCashDrawer: false,
        documentName: options.documentName || 'Shift Close Receipt',
        beforeFeedLines,
        afterFeedLines,
      })
    } catch (error) {
      const message = typeof error === 'string' ? error : error?.message || ''
      if (printerName && /deleted|1905|open printer/i.test(message)) {
        return invoke('print_receipt', {
          printerName: '',
          contents,
          copies: 1,
          openCashDrawer: false,
          documentName: options.documentName || 'Shift Close Receipt',
          beforeFeedLines,
          afterFeedLines,
        })
      }
      throw error
    }
  }

  printWithBrowser([contents], 'shift-close-print')
  return { printerName: 'browser print dialog', copies: 1 }
}

export async function openCashDrawer(options = {}) {
  const printerName = receiptPrinterName(options)
  const invoke = tauriInvoke()

  if (!invoke) {
    throw new Error('Cash drawer opening is only available in the desktop app.')
  }

  await assertReceiptPrinterReady({ ...options, printerName })

  try {
    return await invoke('print_receipt', {
      printerName,
      contents: '',
      copies: 1,
      openCashDrawer: true,
      documentName: 'Cash drawer kick',
      beforeFeedLines: 0,
      afterFeedLines: 0,
    })
  } catch (error) {
    const message = typeof error === 'string' ? error : error?.message || ''
    if (printerName && /deleted|1905|open printer/i.test(message)) {
      return invoke('print_receipt', {
        printerName: '',
        contents: '',
        copies: 1,
        openCashDrawer: true,
        documentName: 'Cash drawer kick',
        beforeFeedLines: 0,
        afterFeedLines: 0,
      })
    }
    throw error
  }
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
