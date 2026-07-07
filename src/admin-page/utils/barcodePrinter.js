import { code128Bars, escapeHtml } from './code128Barcode'

const RECEIPT_WIDTH = 32
const DEFAULT_PRINTER_NAME = 'XP-58H'
const RECEIPT_SETTINGS_KEY = 'nexa_receipt_print_settings'
const BARCODE_PRINT_SETTINGS_KEY = 'nexa_barcode_print_settings'
export const BROWSER_PRINT_VALUE = '__browser_print_dialog__'

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function savedReceiptPrinterName() {
  try {
    const settings = JSON.parse(localStorage.getItem(RECEIPT_SETTINGS_KEY) || '{}')
    return String(settings.printerName || '').trim()
  } catch {
    return ''
  }
}

function savedReceiptSpacing() {
  try {
    const settings = JSON.parse(localStorage.getItem(RECEIPT_SETTINGS_KEY) || '{}')
    return {
      beforeLines: clampNumber(settings.receiptBeforeFeedLines, 0, 0, 8),
      afterLines: clampNumber(settings.receiptAfterFeedLines ?? settings.receiptFeedLines, 1, 0, 8),
    }
  } catch {
    return { beforeLines: 0, afterLines: 1 }
  }
}

function barcodePrinterName(options = {}) {
  return String(options.printerName || savedBarcodePrintSettings().printerName || savedReceiptPrinterName() || import.meta.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_PRINTER_NAME).trim()
}

function center(text = '') {
  const value = cleanText(text).slice(0, RECEIPT_WIDTH)
  const left = Math.max(0, Math.floor((RECEIPT_WIDTH - value.length) / 2))
  return `${' '.repeat(left)}${value}`
}

function barcodeLine(value) {
  const code = cleanText(value).replace(/[^A-Za-z0-9._-]/g, '')
  return code ? `{{BARCODE:${code}}}` : ''
}

function printerStatusMessage(status) {
  const messages = Array.isArray(status?.messages) ? status.messages : []
  const queueCount = Array.isArray(status?.jobs) ? status.jobs.length : 0
  const detail = messages.length ? messages.join(' ') : 'Printer is not ready.'
  return queueCount > 0 ? `${detail} Windows queue has ${queueCount} job(s).` : detail
}

async function assertPrinterReady(invoke, printerName, options = {}) {
  if (options.skipStatusCheck) return
  const status = await invoke('printer_status', { printerName })
  if (!status?.isReady) {
    throw new Error(printerStatusMessage(status))
  }
}

function normalizeLabels(labels) {
  const list = Array.isArray(labels) ? labels : [labels]
  return list
    .map((label) => ({
      title: cleanText(label?.title || 'Barcode'),
      value: cleanText(label?.value),
      meta: cleanText(label?.meta || ''),
    }))
    .filter((label) => label.value)
}

function buildLabelText({ title, value, meta }) {
  const safeTitle = cleanText(title || 'Barcode')
  const safeValue = cleanText(value)
  return [
    safeTitle ? center(safeTitle) : '',
    meta ? center(meta) : '',
    barcodeLine(safeValue),
    '',
  ].filter(Boolean).join('\n')
}

function expandLabels(labels, copies) {
  return labels.flatMap((label) => Array.from({ length: copies }, () => label))
}

function buildBarcodeText(labels, copies) {
  return expandLabels(labels, copies).map(buildLabelText).join('\n')
}

function barcodeSvg(value) {
  const { bars, width } = code128Bars(value)
  const rects = bars.map((bar) => `<rect x="${bar.x}" y="0" width="${bar.width}" height="70" fill="#111827" />`).join('')
  return `<svg viewBox="0 0 ${width} 78" preserveAspectRatio="none" aria-label="Barcode ${escapeHtml(value)}">${rects}</svg>`
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

function pdfText(value, x, y, size = 9) {
  return `BT /F1 ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`
}

function pdfBarcode(label, x, y, width, height) {
  const barcode = code128Bars(label.value)
  if (!barcode.bars.length) return ''

  const scale = width / barcode.width
  return barcode.bars
    .map((bar) => `${(x + (bar.x * scale)).toFixed(2)} ${y.toFixed(2)} ${(bar.width * scale).toFixed(2)} ${height.toFixed(2)} re f`)
    .join('\n')
}

function buildBarcodePdf(inputLabels, copies) {
  const labels = expandLabels(inputLabels, copies)
  const pageWidth = 612
  const pageHeight = 792
  const margin = 36
  const gap = 12
  const labelWidth = 168
  const labelHeight = 112
  const columns = Math.max(1, Math.floor((pageWidth - (margin * 2) + gap) / (labelWidth + gap)))
  const rows = Math.max(1, Math.floor((pageHeight - (margin * 2) + gap) / (labelHeight + gap)))
  const perPage = columns * rows
  const pageCount = Math.max(1, Math.ceil(labels.length / perPage))
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
  ]
  const pageRefs = []
  const fontId = (pageCount * 2) + 3
  let nextObjectId = 3

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageLabels = labels.slice(pageIndex * perPage, (pageIndex + 1) * perPage)
    const commands = []
    pageLabels.forEach((label, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      const left = margin + (col * (labelWidth + gap))
      const top = pageHeight - margin - (row * (labelHeight + gap))
      const bottom = top - labelHeight
      const barcodeTop = bottom + 32
      const title = cleanText(label.title || 'Barcode').slice(0, 32)
      const meta = cleanText(label.meta || '').slice(0, 40)
      const value = cleanText(label.value).slice(0, 44)

      commands.push('0.82 0.84 0.88 RG')
      commands.push(`${left.toFixed(2)} ${bottom.toFixed(2)} ${labelWidth.toFixed(2)} ${labelHeight.toFixed(2)} re S`)
      commands.push('0 0 0 rg')
      commands.push(pdfText(title, left + 10, top - 18, 9))
      if (meta) commands.push(pdfText(meta, left + 10, top - 31, 7))
      commands.push(pdfBarcode(label, left + 10, barcodeTop, labelWidth - 20, 48))
      commands.push(pdfText(value, left + 10, bottom + 14, 8))
    })

    const content = commands.join('\n')
    const pageId = nextObjectId++
    const contentId = nextObjectId++
    pageRefs.push(`${pageId} 0 R`)
    objects.push(pdfObject(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
    objects.push(pdfObject(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
  }

  objects.splice(1, 0, pdfObject(2, `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`))
  objects.push(pdfObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

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

function downloadFile(filename, contents, type = 'application/pdf') {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function printFilename(documentName = 'Barcode Labels') {
  const safeName = cleanText(documentName)
    .replace(/[^A-Za-z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${safeName || 'Barcode Labels'}.pdf`
}

function buildBrowserHtml(inputLabels, copies) {
  const expandedLabels = expandLabels(inputLabels, copies)
  const title = expandedLabels.length === 1 ? expandedLabels[0].title : 'Barcode Labels'
  const labels = expandedLabels.map((label) => `
    <div class="label">
      <h1>${escapeHtml(label.title || 'Barcode')}</h1>
      ${label.meta ? `<p>${escapeHtml(label.meta)}</p>` : ''}
      ${barcodeSvg(label.value)}
      <div class="code">${escapeHtml(label.value)}</div>
    </div>
  `).join('')

  return `<!doctype html>
<html>
<head>
  <title>${escapeHtml(title || 'Barcode')}</title>
  <style>
    @page { size: auto; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111827; }
    .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10mm; align-items: start; }
    .label { break-inside: avoid; border: 1px solid #d1d5db; padding: 12px; text-align: center; min-height: 118px; }
    h1 { font-size: 13px; line-height: 1.25; margin: 0 0 8px; overflow-wrap: anywhere; }
    p { font-size: 10px; margin: -4px 0 8px; color: #4b5563; overflow-wrap: anywhere; }
    svg { width: 100%; height: 72px; display: block; }
    .code { font-family: Consolas, monospace; font-size: 12px; margin-top: 6px; letter-spacing: 1px; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main class="sheet">${labels}</main>
  <script>window.onload = () => { window.print(); window.close(); };</script>
</body>
</html>`
}

function printWithBrowser(labels, copies) {
  const popup = window.open('', 'barcode-print', 'width=720,height=640')
  if (!popup) throw new Error('Barcode print popup was blocked.')
  popup.document.open()
  popup.document.write(buildBrowserHtml(labels, copies))
  popup.document.close()
}

function previewStatusScript(jobId, mode, totalLabels) {
  return `
    const jobId = ${JSON.stringify(jobId)};
    const mode = ${JSON.stringify(mode)};
    const totalLabels = ${Number(totalLabels) || 0};
    const status = document.querySelector('[data-status]');
    const printButton = document.querySelector('[data-print]');
    const saveButton = document.querySelector('[data-save]');
    const closeButton = document.querySelector('[data-close]');
    const setStatus = (message, tone = '') => {
      if (!status) return;
      status.textContent = message;
      status.dataset.tone = tone;
    };
    window.addEventListener('message', (event) => {
      if (!event.data || event.data.jobId !== jobId) return;
      if (event.data.type === 'nexa-barcode-print-status') {
        setStatus(event.data.message || 'Updating print status...', event.data.tone || '');
        if (printButton) printButton.disabled = Boolean(event.data.busy);
        if (saveButton) saveButton.disabled = Boolean(event.data.busy);
      }
    });
    printButton?.addEventListener('click', () => {
      if (mode === 'browser') {
        setStatus('Opening print dialog for ' + totalLabels + ' label' + (totalLabels === 1 ? '' : 's') + '.', 'busy');
        window.print();
        setStatus('Print dialog opened. Confirm the printer and save/print from the dialog.', 'success');
        return;
      }
      setStatus('Sending print job to the selected printer...', 'busy');
      printButton.disabled = true;
      window.opener?.postMessage({ type: 'nexa-barcode-print-confirm', jobId }, '*');
    });
    saveButton?.addEventListener('click', () => {
      setStatus('Opening file picker for this barcode PDF...', 'busy');
      saveButton.disabled = true;
      window.opener?.postMessage({ type: 'nexa-barcode-save-confirm', jobId }, '*');
    });
    closeButton?.addEventListener('click', () => window.close());
  `
}

function buildPreviewHtml(inputLabels, copies, options = {}) {
  const expandedLabels = expandLabels(inputLabels, copies)
  const title = expandedLabels.length === 1 ? expandedLabels[0].title : options.documentName || 'Barcode Labels'
  const mode = options.mode || 'browser'
  const printerName = cleanText(options.printerName || '')
  const labels = expandedLabels.map((label) => `
    <div class="label">
      <h1>${escapeHtml(label.title || 'Barcode')}</h1>
      ${label.meta ? `<p>${escapeHtml(label.meta)}</p>` : ''}
      ${barcodeSvg(label.value)}
      <div class="code">${escapeHtml(label.value)}</div>
    </div>
  `).join('')

  return `<!doctype html>
<html>
<head>
  <title>${escapeHtml(title || 'Barcode Preview')}</title>
  <style>
    @page { size: auto; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111827; background: #f3f4f6; }
    .toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #d1d5db; background: #ffffff; box-shadow: 0 1px 8px rgba(15, 23, 42, 0.08); }
    .toolbar strong { display: block; font-size: 15px; }
    .toolbar span { display: block; margin-top: 3px; font-size: 12px; color: #64748b; }
    .actions { display: flex; gap: 8px; }
    button { border: 1px solid #cbd5e1; border-radius: 7px; background: #ffffff; color: #0f172a; font: inherit; font-weight: 700; padding: 9px 13px; cursor: pointer; }
    button.primary { border-color: #4f46e5; background: #4f46e5; color: #ffffff; }
    button:disabled { opacity: 0.65; cursor: wait; }
    [data-status] { width: 100%; padding: 9px 11px; border: 1px solid #bfdbfe; border-radius: 7px; background: #eff6ff; color: #1d4ed8; font-size: 13px; }
    [data-status][data-tone="busy"] { border-color: #fde68a; background: #fffbeb; color: #92400e; }
    [data-status][data-tone="success"] { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
    [data-status][data-tone="error"] { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
    .page { width: min(100%, 920px); margin: 18px auto; padding: 18px; background: #ffffff; box-shadow: 0 1px 10px rgba(15, 23, 42, 0.12); }
    .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10mm; align-items: start; }
    .label { break-inside: avoid; border: 1px solid #d1d5db; padding: 12px; text-align: center; min-height: 118px; background: #ffffff; }
    h1 { font-size: 13px; line-height: 1.25; margin: 0 0 8px; overflow-wrap: anywhere; }
    p { font-size: 10px; margin: -4px 0 8px; color: #4b5563; overflow-wrap: anywhere; }
    svg { width: 100%; height: 72px; display: block; }
    .code { font-family: Consolas, monospace; font-size: 12px; margin-top: 6px; letter-spacing: 1px; overflow-wrap: anywhere; }
    @media print {
      body { background: #ffffff; }
      .toolbar { display: none; }
      .page { width: auto; margin: 0; padding: 0; box-shadow: none; }
    }
  </style>
</head>
<body>
  <header class="toolbar">
    <div>
      <strong>${escapeHtml(title || 'Barcode Preview')}</strong>
      <span>${expandedLabels.length} label${expandedLabels.length === 1 ? '' : 's'}${printerName ? ` | ${escapeHtml(printerName)}` : ''}</span>
    </div>
    <div class="actions">
      <button type="button" data-close>Close</button>
      <button type="button" data-save>Save PDF</button>
      <button type="button" class="primary" data-print>Print</button>
    </div>
    <div data-status>Preview ready. Review the barcode labels, then click Print.</div>
  </header>
  <main class="page"><section class="sheet">${labels}</section></main>
  <script>${previewStatusScript(options.jobId, mode, expandedLabels.length)}</script>
</body>
</html>`
}

function openBarcodePreview(labels, copies, options = {}, onPrint, onSave) {
  const popup = window.open('', `barcode-preview-${options.jobId}`, 'width=920,height=720')
  if (!popup) throw new Error('Barcode preview popup was blocked.')

  const handler = async (event) => {
    if (!event.data || event.data.jobId !== options.jobId) return
    if (event.data.type === 'nexa-barcode-save-confirm') {
      try {
        const path = await onSave()
        popup.postMessage({
          type: 'nexa-barcode-print-status',
          jobId: options.jobId,
          message: path ? `Saved barcode PDF to ${path}.` : 'Save cancelled.',
          tone: path ? 'success' : '',
          busy: false,
        }, '*')
      } catch (error) {
        popup.postMessage({
          type: 'nexa-barcode-print-status',
          jobId: options.jobId,
          message: error?.message || 'Unable to save barcode PDF.',
          tone: 'error',
          busy: false,
        }, '*')
      }
      return
    }

    if (event.data.type !== 'nexa-barcode-print-confirm') return
    try {
      popup.postMessage({
        type: 'nexa-barcode-print-status',
        jobId: options.jobId,
        message: 'Checking printer and sending barcode labels...',
        tone: 'busy',
        busy: true,
      }, '*')
      const result = await onPrint()
      popup.postMessage({
        type: 'nexa-barcode-print-status',
        jobId: options.jobId,
        message: `Printed ${result?.copies || labels.length * copies} barcode label${(result?.copies || labels.length * copies) === 1 ? '' : 's'} to ${result?.printerName || 'printer'}.`,
        tone: 'success',
        busy: false,
      }, '*')
    } catch (error) {
      popup.postMessage({
        type: 'nexa-barcode-print-status',
        jobId: options.jobId,
        message: error?.message || 'Unable to print barcode labels.',
        tone: 'error',
        busy: false,
      }, '*')
    }
  }

  window.addEventListener('message', handler)
  const cleanupTimer = window.setInterval(() => {
    if (popup.closed) {
      window.removeEventListener('message', handler)
      window.clearInterval(cleanupTimer)
    }
  }, 1000)

  popup.document.open()
  popup.document.write(buildPreviewHtml(labels, copies, options))
  popup.document.close()
}

export function savedBarcodePrintSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(BARCODE_PRINT_SETTINGS_KEY) || '{}')
    return {
      printerName: String(settings.printerName || '').trim(),
      copies: clampNumber(settings.copies, 1, 1, 99),
    }
  } catch {
    return { printerName: '', copies: 1 }
  }
}

export function saveBarcodePrintSettings(settings = {}) {
  const next = {
    ...savedBarcodePrintSettings(),
    ...settings,
  }
  next.printerName = String(next.printerName || '').trim()
  next.copies = clampNumber(next.copies, 1, 1, 99)
  localStorage.setItem(BARCODE_PRINT_SETTINGS_KEY, JSON.stringify(next))
  return next
}

export async function listBarcodePrinters() {
  const invoke = tauriInvoke()
  if (!invoke) return []
  return invoke('list_printers').catch(() => [])
}

export async function printBarcodeLabels(inputLabels, options = {}) {
  const labels = normalizeLabels(inputLabels)
  if (labels.length === 0) throw new Error('Select at least one barcode before printing.')

  const copies = clampNumber(options.copies, 1, 1, 99)
  const useBrowserPrint = options.printerName === BROWSER_PRINT_VALUE || options.mode === 'browser'
  const printerName = barcodePrinterName(options)
  const spacing = savedReceiptSpacing()
  const beforeFeedLines = clampNumber(options.beforeFeedLines ?? spacing.beforeLines, 0, 0, 8)
  const afterFeedLines = clampNumber(options.afterFeedLines ?? spacing.afterLines, 1, 0, 8)
  const contents = buildBarcodeText(labels, copies)
  const documentName = options.documentName || (labels.length === 1 ? `Barcode ${labels[0].value}` : `Barcode Labels (${labels.length})`)
  const invoke = tauriInvoke()

  if (options.preview !== false) {
    const jobId = `barcode-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const previewPrinterName = useBrowserPrint ? 'Print dialog / sheet' : printerName
    openBarcodePreview(labels, copies, {
      ...options,
      jobId,
      printerName: previewPrinterName,
      documentName,
      mode: useBrowserPrint || !invoke ? 'browser' : 'direct',
    }, () => printBarcodeLabels(labels, { ...options, preview: false }), () => saveBarcodeLabelsPdf(labels, {
      ...options,
      copies,
      documentName,
    }))
    return {
      preview: true,
      printerName: previewPrinterName,
      copies: labels.length * copies,
    }
  }

  if (invoke && !useBrowserPrint) {
    await assertPrinterReady(invoke, printerName, options)
    try {
      return await invoke('print_receipt', {
        printerName,
        contents,
        copies: 1,
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
          documentName,
          beforeFeedLines,
          afterFeedLines,
        })
      }
      throw error
    }
  }

  printWithBrowser(labels, copies)
  return { printerName: 'browser print dialog', copies: labels.length * copies }
}

export async function saveBarcodeLabelsPdf(inputLabels, options = {}) {
  const labels = normalizeLabels(inputLabels)
  if (labels.length === 0) throw new Error('Select at least one barcode before saving.')

  const copies = clampNumber(options.copies, 1, 1, 99)
  const documentName = options.documentName || (labels.length === 1 ? `Barcode ${labels[0].value}` : `Barcode Labels (${labels.length})`)
  const filename = printFilename(documentName)
  const contents = buildBarcodePdf(labels, copies, options)
  const invoke = tauriInvoke()

  if (invoke) {
    return invoke('save_print_file', {
      defaultFilename: filename,
      contents,
      fileType: 'PDF',
      extension: 'pdf',
    })
  }

  downloadFile(filename, contents)
  return filename
}
