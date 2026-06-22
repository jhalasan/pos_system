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
    const paid = cash + gcash
    return [
      columns('Payment', 'Split'),
      columns('Cash', moneyValue(cash)),
      columns('GCash', moneyValue(gcash)),
      columns('Paid', moneyValue(paid)),
      columns('Change', moneyValue(Math.max(0, paid - Number(payment.totalAmount || 0)))),
    ]
  }

  if (payment.paymentMethod === 'gcash') {
    return [
      columns('Payment', 'GCash'),
      payment.gcashRef ? columns('Ref', payment.gcashRef) : '',
    ].filter(Boolean)
  }

  return [
    columns('Payment', 'Cash'),
    columns('Cash', moneyValue(payment.cashAmount)),
    columns('Change', moneyValue(Math.max(0, Number(payment.change) || 0))),
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

function printWithBrowser(receipts) {
  const popup = window.open('', 'receipt-print', 'width=360,height=640')
  if (!popup) throw new Error('Receipt popup was blocked.')
  popup.document.open()
  popup.document.write(buildPrintableHtml(receipts))
  popup.document.close()
}

export async function printCompletedReceipt(receiptData) {
  const printerName = import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME
  const copies = envNumber(import.meta.env.VITE_RECEIPT_COPIES, DEFAULT_COPY_COUNT)
  const labels = ['Customer Copy', 'Store Copy']
  const receipts = Array.from({ length: copies }, (_, index) => buildReceiptText({
    ...receiptData,
    copyLabel: labels[index] || `Copy ${index + 1}`,
  }))
  const invoke = tauriInvoke()

  if (invoke) {
    return invoke('print_receipt', {
      printerName,
      contents: receipts.join('\n'),
      copies: 1,
    })
  }

  printWithBrowser(receipts)
  return { printerName: 'browser print dialog', copies }
}
