const RECEIPT_WIDTH = 32
const DEFAULT_PRINTER_NAME = 'XP-58H'

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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

function productStatus(product) {
  if (Number(product.qty) <= 0) return 'Out of Stock'
  if (product.status === 'critical') return 'Critical'
  if (product.status === 'low') return 'Low Stock'
  return 'In Stock'
}

function inventoryProductLines(product) {
  const name = cleanText(product.name || 'Unnamed Product')
  const barcode = cleanText(product.barcode || product.sku || product.id || '')
  const category = cleanText(product.category || 'Uncategorized')
  const qty = Number(product.qty) || 0
  const unit = cleanText(product.unit || 'unit')

  return [
    name.slice(0, RECEIPT_WIDTH),
    barcode ? barcode.slice(0, RECEIPT_WIDTH) : '',
    columns(`Qty ${qty} ${unit}`, productStatus(product)),
    category.slice(0, RECEIPT_WIDTH),
  ].filter(Boolean)
}

function buildInventoryText(products, { title = 'Inventory Report' } = {}) {
  const printedAt = new Date()
  const totalUnits = products.reduce((sum, product) => sum + (Number(product.qty) || 0), 0)

  return [
    center('NEXA POS'),
    center(title),
    line(),
    columns('Printed', printedAt.toLocaleString('en-PH')),
    columns('Products', products.length),
    columns('Total Units', totalUnits),
    line(),
    ...products.flatMap((product, index) => [
      ...inventoryProductLines(product),
      index === products.length - 1 ? '' : line('.'),
    ]),
    line(),
    center('End of inventory copy'),
    '\n\n\n',
  ].filter((entry) => entry !== null && entry !== undefined).join('\n')
}

function stockOutLines(record) {
  const name = cleanText(record.name || 'Unnamed Product')
  const barcode = cleanText(record.barcode || record.sku || record.id || '')
  const reason = cleanText(record.reasonLabel || record.reason || 'Stock-out')
  const note = cleanText(record.note || '')
  const qty = Number(record.qty) || 0

  return [
    name.slice(0, RECEIPT_WIDTH),
    barcode ? barcode.slice(0, RECEIPT_WIDTH) : '',
    columns(`Qty Out ${qty}`, reason),
    note ? `Note: ${note}`.slice(0, RECEIPT_WIDTH) : '',
    columns('Stock Now', Number(record.newQty) || 0),
  ].filter(Boolean)
}

export function buildStockOutText(records, { title = 'Stock-Out Report' } = {}) {
  const printedAt = new Date()
  const totalUnits = records.reduce((sum, record) => sum + (Number(record.qty) || 0), 0)

  return [
    center('NEXA POS'),
    center(title),
    line(),
    columns('Printed', printedAt.toLocaleString('en-PH')),
    columns('Records', records.length),
    columns('Units Out', totalUnits),
    line(),
    ...records.flatMap((record, index) => [
      ...stockOutLines(record),
      index === records.length - 1 ? '' : line('.'),
    ]),
    line(),
    center('End of stock-out copy'),
    '\n\n\n',
  ].filter((entry) => entry !== null && entry !== undefined).join('\n')
}

function buildPrintableHtml(contents) {
  const escaped = String(contents).replace(/[&<>]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  }[char]))

  return `<!doctype html>
<html>
<head>
  <title>Inventory Print</title>
  <style>
    @page { size: 58mm auto; margin: 3mm; }
    body { margin: 0; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; }
  </style>
</head>
<body>${escaped}<script>window.onload = () => { window.print(); window.close(); };</script></body>
</html>`
}

function printWithBrowser(contents) {
  const popup = window.open('', 'inventory-print', 'width=360,height=640')
  if (!popup) throw new Error('Inventory print popup was blocked.')
  popup.document.open()
  popup.document.write(buildPrintableHtml(contents))
  popup.document.close()
}

export async function printInventoryProducts(products, options = {}) {
  if (!products.length) throw new Error('No products to print.')

  const printerName = import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME
  const contents = buildInventoryText(products, options)
  const invoke = tauriInvoke()

  if (invoke) {
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

  printWithBrowser(contents)
  return { printerName: 'browser print dialog', copies: 1 }
}

export async function printStockOutRecords(records, options = {}) {
  if (!records.length) throw new Error('No stock-out records to print.')

  const printerName = import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME
  const contents = buildStockOutText(records, options)
  const invoke = tauriInvoke()

  if (invoke) {
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

  printWithBrowser(contents)
  return { printerName: 'browser print dialog', copies: 1 }
}
