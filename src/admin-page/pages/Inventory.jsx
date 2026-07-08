import { useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import ProductModal from '../components/ProductModal'
import { IconBox, IconAlert, IconDollar, IconScan, IconCheck, IconTrash, IconDownload, IconPrint } from '../components/Icons'
import { api, defaultCategories, peso, statusLabel } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { buildStockOutText, printStockOutRecords } from '../utils/thermalInventoryPrinter'

const stockOutReasons = {
  expired: 'Expired goods',
  damaged: 'Damaged goods',
  other: 'Other stock-out',
}

function normalizeSellingUnits(product = {}) {
  const rawUnits = Array.isArray(product.sellingUnits)
    ? product.sellingUnits
    : (Array.isArray(product.selling_units) ? product.selling_units : [])
  const fallbackUnit = String(product.unit || 'Piece').trim() || 'Piece'
  const fallbackBarcode = String(product.barcode || '').trim()
  const fallbackPrice = Number(product.price) || 0

  const units = rawUnits.length > 0
    ? rawUnits.map((unit) => ({
      barcode: String(unit?.barcode || '').trim(),
      unit: String(unit?.unit || '').trim() || fallbackUnit,
      conversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
      price: Number(unit?.price) || fallbackPrice,
    }))
    : []

  const purchaseUnit = String(product.purchaseUnit || product.purchase_unit || '').trim()
  const purchaseConversion = Number(product.conversionQuantity ?? product.conversion_quantity)
  if (purchaseUnit && purchaseConversion > 1 && purchaseUnit.toLowerCase() !== fallbackUnit.toLowerCase()) {
    const hasPurchaseUnit = units.some((unit) => (
      unit.unit.toLowerCase() === purchaseUnit.toLowerCase()
      || Number(unit.conversion) === purchaseConversion
    ))
    if (!hasPurchaseUnit) {
      units.push({
        barcode: '',
        unit: purchaseUnit,
        conversion: purchaseConversion,
        price: fallbackPrice * purchaseConversion,
      })
    }
  }

  if (units.length > 0) return units

  return [{
    barcode: fallbackBarcode,
    unit: fallbackUnit,
    conversion: 1,
    price: fallbackPrice,
  }]
}

function matchSellingUnit(product, barcode) {
  const code = String(barcode || '').trim()
  if (!code) return null
  return normalizeSellingUnits(product).find((unit) => String(unit.barcode || '').trim() === code) || null
}

function productMatchesBarcode(product, barcode) {
  return Boolean(matchSellingUnit(product, barcode) || String(product.barcode || '').trim() === String(barcode || '').trim())
}

function findProductByBarcode(products, barcode) {
  const code = String(barcode || '').trim()
  if (!code) return null
  return products.find((product) => productMatchesBarcode(product, code)) || null
}

function productMatchesQuery(product, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return false
  return product.name.toLowerCase().includes(q)
    || String(product.barcode || '').toLowerCase().includes(q)
    || normalizeSellingUnits(product).some((unit) => (
      String(unit.barcode || '').toLowerCase().includes(q)
      || String(unit.unit || '').toLowerCase().includes(q)
    ))
}

function scannedUnitLabel(product, barcode) {
  const unit = matchSellingUnit(product, barcode)
  return unit?.unit || product?.unit || 'unit(s)'
}

function scannedUnitConversion(product, barcode) {
  const unit = matchSellingUnit(product, barcode)
  return Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1
}

function unitOptionValue(unit, index = 0) {
  const barcode = String(unit?.barcode || '').trim()
  if (barcode) return `barcode:${barcode}`
  return `unit:${String(unit?.unit || 'Unit').trim()}:${Number(unit?.conversion) || 1}:${index}`
}

function unitFromOption(product, optionValue, fallbackBarcode = '') {
  const units = normalizeSellingUnits(product)
  if (!product || units.length === 0) return null
  if (optionValue?.startsWith('barcode:')) {
    const barcode = optionValue.slice('barcode:'.length)
    return units.find((unit) => String(unit.barcode || '').trim() === barcode) || units[0]
  }
  if (optionValue?.startsWith('unit:')) {
    const [, unitName, conversion] = optionValue.split(':')
    const normalizedConversion = Number(conversion)
    return units.find((unit) => (
      String(unit.unit || '').trim() === unitName
      && Number(unit.conversion) === normalizedConversion
    )) || units[0]
  }
  return matchSellingUnit(product, fallbackBarcode) || units[0]
}

function scanPayloadForUnit(product, unit, qty) {
  return {
    productId: product?.id || '',
    barcode: String(unit?.barcode || '').trim(),
    unitConversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
    unitLabel: String(unit?.unit || product?.unit || 'unit(s)').trim(),
    qty,
  }
}

function formatQty(value) {
  return Number(value || 0).toLocaleString('en-PH')
}

function pluralizeUnit(unit, quantity) {
  const cleanUnit = String(unit || 'unit').trim() || 'unit'
  if (Number(quantity) === 1 || /s$/i.test(cleanUnit)) return cleanUnit
  return `${cleanUnit}s`
}

function unitEquivalentText(product, unit, qty = 1) {
  if (!product || !unit) return ''
  const baseQty = Math.max(1, Number(qty) || 1) * (Number(unit.conversion) > 0 ? Number(unit.conversion) : 1)
  const units = normalizeSellingUnits(product)
    .filter((candidate) => Number(candidate.conversion) > 0 && baseQty >= Number(candidate.conversion))
    .sort((a, b) => Number(b.conversion) - Number(a.conversion))

  const parts = units.map((candidate) => {
    const count = baseQty / Number(candidate.conversion)
    if (!Number.isInteger(count)) return null
    return `${formatQty(count)} ${pluralizeUnit(candidate.unit, count)}`
  }).filter(Boolean)

  if (parts.length === 0) return `${formatQty(baseQty)} ${pluralizeUnit(product.unit, baseQty)}`
  return parts.join(' = ')
}

function pdfEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function buildTextPdf(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '')
  const pageHeight = Math.max(300, (lines.length * 10) + 40)
  const content = [
    'BT',
    '/F1 8 Tf',
    '10 TL',
    `10 ${pageHeight - 20} Td`,
    ...lines.map((line) => `(${pdfEscape(line)}) Tj T*`),
    'ET',
  ].join('\n')
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 164 ${pageHeight}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(pdf.length)
    pdf += object
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return pdf
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

export default function Inventory() {
  const { data: products, setData: setProducts, loading, error } = useApi(api.products, [])
  const { data: categoryRecords } = useApi(api.categories, [])
  const barcodeRef = useRef(null)
  const stockOutRef = useRef(null)
  const [inventoryTab, setInventoryTab] = useState('stock-in')
  const [barcode, setBarcode] = useState('')
  const [stockInUnit, setStockInUnit] = useState('')
  const [qty, setQty] = useState(1)
  const [feed, setFeed] = useState([])
  const [scanMode, setScanMode] = useState('instant')
  const [batchItems, setBatchItems] = useState([])
  const [confirmingBatch, setConfirmingBatch] = useState(false)
  const [scanError, setScanError] = useState('')
  const [newProductBarcode, setNewProductBarcode] = useState('')
  const [toast, setToast] = useState('')
  const [stockOutBarcode, setStockOutBarcode] = useState('')
  const [stockOutUnit, setStockOutUnit] = useState('')
  const [stockOutQty, setStockOutQty] = useState(1)
  const [stockOutMode, setStockOutMode] = useState('batch')
  const [stockOutReason, setStockOutReason] = useState('expired')
  const [stockOutNote, setStockOutNote] = useState('')
  const [stockOutBatch, setStockOutBatch] = useState([])
  const [stockOutFeed, setStockOutFeed] = useState([])
  const [stockOutError, setStockOutError] = useState('')
  const [confirmingStockOut, setConfirmingStockOut] = useState(false)

  const totalProducts = products.length
  const lowItems = products.filter((p) => p.status !== 'in-stock').length
  const stockValue = products.reduce((s, p) => s + p.qty * p.price, 0)
  const categories = useMemo(() => {
    return [...new Set([
      ...defaultCategories,
      ...categoryRecords.map((category) => category.name).filter(Boolean),
      ...products.map((p) => p.category).filter(Boolean),
    ])]
  }, [categoryRecords, products])
  const scannedUnits = feed.reduce((s, f) => s + (Number(f.baseQty) || Number(f.qty) || 0), 0)
  const batchUnits = batchItems.reduce((s, item) => s + (Number(item.baseQty) || Number(item.qty) || 0), 0)
  const sessionUnits = scannedUnits + batchUnits
  const stockOutBatchUnits = stockOutBatch.reduce((s, item) => s + (Number(item.baseQty) || Number(item.qty) || 0), 0)
  const stockOutSessionUnits = stockOutFeed.reduce((s, item) => s + (Number(item.baseQty) || Number(item.qty) || 0), 0) + stockOutBatchUnits
  const pendingById = useMemo(() => {
    return batchItems.reduce((map, item) => ({ ...map, [item.id]: (map[item.id] || 0) + (Number(item.baseQty) || Number(item.qty) || 0) }), {})
  }, [batchItems])
  const scannedProduct = useMemo(() => {
    const code = barcode.trim()
    if (!code) return null
    return findProductByBarcode(products, code)
  }, [barcode, products])
  const stockInUnitOptions = useMemo(() => (
    scannedProduct ? normalizeSellingUnits(scannedProduct) : []
  ), [scannedProduct])
  const selectedStockInUnit = useMemo(() => (
    scannedProduct ? unitFromOption(scannedProduct, stockInUnit, barcode.trim()) : null
  ), [scannedProduct, stockInUnit, barcode])
  const barcodeMatches = useMemo(() => {
    const query = barcode.trim().toLowerCase()
    if (!query || scannedProduct) return []
    return products
      .filter((p) => productMatchesQuery(p, query))
      .slice(0, 6)
  }, [barcode, products, scannedProduct])
  const hasUnknownBarcode = barcode.trim() && !scannedProduct
  const stockOutProduct = useMemo(() => {
    const code = stockOutBarcode.trim()
    if (!code) return null
    return findProductByBarcode(products, code)
  }, [stockOutBarcode, products])
  const stockOutUnitOptions = useMemo(() => (
    stockOutProduct ? normalizeSellingUnits(stockOutProduct) : []
  ), [stockOutProduct])
  const selectedStockOutUnit = useMemo(() => (
    stockOutProduct ? unitFromOption(stockOutProduct, stockOutUnit, stockOutBarcode.trim()) : null
  ), [stockOutProduct, stockOutUnit, stockOutBarcode])
  const stockOutMatches = useMemo(() => {
    const query = stockOutBarcode.trim().toLowerCase()
    if (!query || stockOutProduct) return []
    return products
      .filter((p) => productMatchesQuery(p, query))
      .slice(0, 6)
  }, [products, stockOutBarcode, stockOutProduct])
  const pendingStockOutById = useMemo(() => {
    return stockOutBatch.reduce((map, item) => ({ ...map, [item.id]: (map[item.id] || 0) + (Number(item.baseQty) || Number(item.qty) || 0) }), {})
  }, [stockOutBatch])

  function focusBarcode() {
    window.requestAnimationFrame(() => barcodeRef.current?.focus())
  }

  function focusStockOutBarcode() {
    window.requestAnimationFrame(() => stockOutRef.current?.focus())
  }

  function flash(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }

  function mergeUpdatedProduct(list, updated) {
    let matched = false
    const next = list.map((product) => {
      const sameProduct = product.id === updated.id
        || (updated.barcode && product.barcode === updated.barcode)
      if (!sameProduct) return product
      matched = true
      return updated
    })
    return matched ? next : [updated, ...next]
  }

  function addToBatch(product, unit, count) {
    const selectedUnit = unit || matchSellingUnit(product, barcode.trim()) || normalizeSellingUnits(product)[0]
    const scannedBarcode = String(selectedUnit?.barcode || '').trim()
    const unitKey = unitOptionValue(selectedUnit)
    const conversion = Number(selectedUnit?.conversion) > 0 ? Number(selectedUnit.conversion) : scannedUnitConversion(product, scannedBarcode)
    const baseQty = count * conversion
    const unitLabel = selectedUnit?.unit || scannedUnitLabel(product, scannedBarcode)
    const equivalentText = unitEquivalentText(product, selectedUnit, count)
    setBatchItems((items) => {
      const existing = items.find((item) => item.id === product.id && item.unitKey === unitKey)
      if (existing) {
        return items.map((item) => (
          item.id === product.id && item.unitKey === unitKey
            ? {
              ...item,
              qty: item.qty + count,
              baseQty: item.baseQty + baseQty,
              equivalentText: unitEquivalentText(product, selectedUnit, item.qty + count),
              lastScannedAt: new Date(),
            }
            : item
        ))
      }

      return [
        {
          id: product.id,
          sku: product.sku || product.id,
          name: product.name,
          barcode: scannedBarcode,
          unitKey,
          category: product.category,
          currentQty: Number(product.qty) || 0,
          unit: unitLabel,
          baseUnit: product.unit || 'unit(s)',
          sellingUnits: normalizeSellingUnits(product),
          conversion,
          qty: count,
          baseQty,
          equivalentText,
          lastScannedAt: new Date(),
        },
        ...items,
      ]
    })
  }

  function updateBatchItemQty(productId, itemUnitKey, value) {
    const nextQty = Math.max(1, Math.floor(Number(value) || 1))
    setBatchItems((items) => items.map((item) => (
      item.id === productId && item.unitKey === itemUnitKey
        ? {
          ...item,
          qty: nextQty,
          baseQty: nextQty * (Number(item.conversion) || 1),
          equivalentText: unitEquivalentText({ ...item, unit: item.baseUnit }, item, nextQty),
        }
        : item
    )))
  }

  async function scan(e) {
    e.preventDefault()
    const code = barcode.trim()
    if (!code) return
    const stockInQty = Math.max(1, Math.floor(Number(qty) || 1))

    if (scanMode === 'batch') {
      if (!scannedProduct) {
        setScanError(`No product found for barcode "${code}".`)
        focusBarcode()
        return
      }
      addToBatch(scannedProduct, selectedStockInUnit, stockInQty)
      setBarcode('')
      setScanError('')
      flash(`Counted ${stockInQty} ${selectedStockInUnit?.unit || scannedProduct.unit || 'unit(s)'} for ${scannedProduct.name}.`)
      focusBarcode()
      return
    }

    if (!scannedProduct) {
      setScanError(`No product found for barcode "${code}".`)
      focusBarcode()
      return
    }

    try {
      const payload = scanPayloadForUnit(scannedProduct, selectedStockInUnit, stockInQty)
      const equivalentText = unitEquivalentText(scannedProduct, selectedStockInUnit, stockInQty)
      const updated = await api.scanInventory(payload)
      setProducts((current) => mergeUpdatedProduct(current, updated))
      setFeed((f) => [
        {
          key: `${Date.now()}-${updated.id}`,
          name: updated.name,
          id: updated.sku || updated.id,
          barcode: payload.barcode || code,
          qty: stockInQty,
          unit: payload.unitLabel,
          baseQty: stockInQty * payload.unitConversion,
          equivalentText,
          newQty: updated.qty,
          time: new Date(),
        },
        ...f.slice(0, 14),
      ])
      setBarcode('')
      setScanError('')
      flash(`Added ${stockInQty} ${payload.unitLabel} to ${updated.name}.`)
      focusBarcode()
    } catch (err) {
      setScanError(err.message || `No product found for barcode "${code}".`)
      focusBarcode()
    }
  }

  async function confirmBatch() {
    if (batchItems.length === 0 || confirmingBatch) return

    setConfirmingBatch(true)
    setScanError('')

    try {
      let nextProducts = products
      const confirmedFeed = []

      for (const item of batchItems) {
        const updated = await api.scanInventory({
          barcode: item.barcode,
          productId: item.id,
          unitConversion: item.conversion,
          unitLabel: item.unit,
          qty: item.qty,
        })
        nextProducts = mergeUpdatedProduct(nextProducts, updated)
        confirmedFeed.push({
          key: `${Date.now()}-${updated.id}`,
          name: updated.name,
          id: updated.sku || updated.id,
          barcode: item.barcode || updated.barcode,
          qty: item.qty,
          unit: item.unit,
          baseQty: item.baseQty,
          equivalentText: item.equivalentText,
          newQty: updated.qty,
          time: new Date(),
        })
      }

      setProducts(nextProducts)
      setFeed((f) => [...confirmedFeed, ...f].slice(0, 15))
      setBatchItems([])
      flash(`Confirmed ${batchUnits} ${batchItems[0]?.baseUnit || 'base unit(s)'} across ${batchItems.length} line(s).`)
      focusBarcode()
    } catch (err) {
      setScanError(err.message || 'Unable to confirm stock-in batch.')
      focusBarcode()
    } finally {
      setConfirmingBatch(false)
    }
  }

  function stockOutReasonLabel(reason = stockOutReason) {
    return stockOutReasons[reason] || stockOutReasons.other
  }

  function stockOutAvailable(product) {
    if (!product) return 0
    return Math.max(0, (Number(product.qty) || 0) - (pendingStockOutById[product.id] || 0))
  }

  function addToStockOutBatch(product, unit, count) {
    const selectedUnit = unit || matchSellingUnit(product, stockOutBarcode.trim()) || normalizeSellingUnits(product)[0]
    const scannedBarcode = String(selectedUnit?.barcode || '').trim()
    const unitKey = unitOptionValue(selectedUnit)
    const conversion = Number(selectedUnit?.conversion) > 0 ? Number(selectedUnit.conversion) : scannedUnitConversion(product, scannedBarcode)
    const baseQty = count * conversion
    const unitLabel = selectedUnit?.unit || scannedUnitLabel(product, scannedBarcode)
    const equivalentText = unitEquivalentText(product, selectedUnit, count)
    const available = stockOutAvailable(product)
    if (available < baseQty) {
      setStockOutError(`"${product.name}" has only ${available} available item(s) after pending stock-out.`)
      return false
    }

    setStockOutBatch((items) => {
      const existing = items.find((item) => item.id === product.id && item.unitKey === unitKey)
      if (existing) {
        return items.map((item) => (
          item.id === product.id && item.unitKey === unitKey
            ? {
              ...item,
              qty: item.qty + count,
              baseQty: item.baseQty + baseQty,
              equivalentText: unitEquivalentText(product, selectedUnit, item.qty + count),
              reason: stockOutReason,
              reasonLabel: stockOutReasonLabel(),
              note: stockOutNote,
              lastScannedAt: new Date(),
            }
            : item
        ))
      }

      return [
        {
          id: product.id,
          sku: product.sku || product.id,
          name: product.name,
          barcode: scannedBarcode,
          unitKey,
          category: product.category,
          currentQty: Number(product.qty) || 0,
          unit: unitLabel,
          baseUnit: product.unit || 'unit(s)',
          sellingUnits: normalizeSellingUnits(product),
          conversion,
          qty: count,
          baseQty,
          equivalentText,
          reason: stockOutReason,
          reasonLabel: stockOutReasonLabel(),
          note: stockOutNote,
          lastScannedAt: new Date(),
        },
        ...items,
      ]
    })
    return true
  }

  function updateStockOutBatchItemQty(productId, itemUnitKey, value) {
    const requestedQty = Math.max(1, Math.floor(Number(value) || 1))
    setStockOutBatch((items) => items.map((item) => {
      if (item.id !== productId || item.unitKey !== itemUnitKey) return item
      const conversion = Number(item.conversion) || 1
      const maxQty = Math.max(1, Math.floor((Number(item.currentQty) || 0) / conversion))
      const nextQty = Math.min(requestedQty, maxQty)
      if (requestedQty > maxQty) {
        setStockOutError(`"${item.name}" has only ${maxQty} ${item.unit || 'unit(s)'} available.`)
      } else {
        setStockOutError('')
      }
      return {
        ...item,
        qty: nextQty,
        baseQty: nextQty * conversion,
        equivalentText: unitEquivalentText({ ...item, unit: item.baseUnit }, item, nextQty),
      }
    }))
  }

  function stockOutFeedRecord(product, qtyOut, updated, reason = stockOutReason, note = stockOutNote, scannedBarcode = product.barcode, unit = null) {
    const conversion = Number(unit?.conversion) > 0 ? Number(unit.conversion) : scannedUnitConversion(product, scannedBarcode)
    const unitLabel = unit?.unit || scannedUnitLabel(product, scannedBarcode)
    const equivalentText = unitEquivalentText(product, unit || matchSellingUnit(product, scannedBarcode), qtyOut)
    return {
      key: `${Date.now()}-${updated.id}-${Math.random().toString(36).slice(2)}`,
      id: updated.sku || updated.id,
      name: updated.name,
      barcode: scannedBarcode || updated.barcode,
      qty: qtyOut,
      unit: unitLabel,
      baseQty: qtyOut * conversion,
      equivalentText,
      previousQty: Number(product.qty) || 0,
      newQty: updated.qty,
      reason,
      reasonLabel: stockOutReasonLabel(reason),
      note,
      time: new Date(),
    }
  }

  async function scanStockOut(e) {
    e.preventDefault()
    const code = stockOutBarcode.trim()
    if (!code) return
    const removeQty = Math.max(1, Math.floor(Number(stockOutQty) || 1))

    if (!stockOutProduct) {
      setStockOutError(`No product found for barcode "${code}".`)
      focusStockOutBarcode()
      return
    }

    if (stockOutMode === 'batch') {
      if (!addToStockOutBatch(stockOutProduct, selectedStockOutUnit, removeQty)) {
        focusStockOutBarcode()
        return
      }
      setStockOutBarcode('')
      setStockOutError('')
      flash(`Queued ${removeQty} ${selectedStockOutUnit?.unit || stockOutProduct.unit || 'unit(s)'} out for ${stockOutProduct.name}.`)
      focusStockOutBarcode()
      return
    }

    try {
      const original = stockOutProduct
      const payload = scanPayloadForUnit(stockOutProduct, selectedStockOutUnit, removeQty)
      const updated = await api.stockOutInventory({
        ...payload,
        qty: removeQty,
        reason: stockOutReason,
        note: stockOutNote,
      })
      setProducts((current) => mergeUpdatedProduct(current, updated))
      setStockOutFeed((items) => [
        stockOutFeedRecord(original, removeQty, updated, stockOutReason, stockOutNote, payload.barcode || code, selectedStockOutUnit),
        ...items.slice(0, 24),
      ])
      setStockOutBarcode('')
      setStockOutError('')
      flash(`Removed ${removeQty} ${payload.unitLabel} from ${updated.name}.`)
      focusStockOutBarcode()
    } catch (err) {
      setStockOutError(err.message || `Unable to stock-out barcode "${code}".`)
      focusStockOutBarcode()
    }
  }

  async function confirmStockOutBatch() {
    if (stockOutBatch.length === 0 || confirmingStockOut) return

    const invalidItem = stockOutBatch.find((item) => (Number(item.qty) || 0) < 1 || (Number(item.baseQty) || 0) > (Number(item.currentQty) || 0))
    if (invalidItem) {
      const maxQty = Math.floor((Number(invalidItem.currentQty) || 0) / (Number(invalidItem.conversion) || 1))
      setStockOutError(`Check quantity for "${invalidItem.name}". It must be between 1 and ${maxQty} ${invalidItem.unit || 'unit(s)'}.`)
      focusStockOutBarcode()
      return
    }

    setConfirmingStockOut(true)
    setStockOutError('')

    try {
      let nextProducts = products
      const confirmedFeed = []

      for (const item of stockOutBatch) {
        const original = nextProducts.find((product) => product.id === item.id) || item
        const updated = await api.stockOutInventory({
          barcode: item.barcode,
          productId: item.id,
          unitConversion: item.conversion,
          unitLabel: item.unit,
          qty: item.qty,
          reason: item.reason,
          note: item.note,
        })
        nextProducts = mergeUpdatedProduct(nextProducts, updated)
        confirmedFeed.push(stockOutFeedRecord(original, item.qty, updated, item.reason, item.note, item.barcode, item))
      }

      setProducts(nextProducts)
      setStockOutFeed((items) => [...confirmedFeed, ...items].slice(0, 25))
      setStockOutBatch([])
      flash(`Confirmed ${stockOutBatchUnits} ${stockOutBatch[0]?.baseUnit || 'base unit(s)'} out across ${stockOutBatch.length} line(s).`)
      focusStockOutBarcode()
    } catch (err) {
      setStockOutError(err.message || 'Unable to confirm stock-out batch.')
      focusStockOutBarcode()
    } finally {
      setConfirmingStockOut(false)
    }
  }

  async function handleExportStockOut() {
    if (!stockOutFeed.length) return
    const result = await exportCsv(`stock-out-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Date / Time', 'Product', 'Barcode', 'Reason', 'Note', 'Qty Out', 'Previous Qty', 'New Qty'],
      ...stockOutFeed.map((item) => [
        item.time.toLocaleString('en-PH'),
        item.name,
        item.barcode || '',
        item.reasonLabel,
        item.note || '',
        item.qty,
        item.previousQty,
        item.newQty,
      ]),
    ], { directory: getExportLocation(exportLocationKeys.products) })
    flash(`Stock-out sheet exported to ${result.path}.`)
  }

  async function handlePrintStockOut() {
    try {
      await printStockOutRecords(stockOutFeed)
      flash('Stock-out report sent to printer.')
    } catch (err) {
      flash((typeof err === 'string' ? err : err.message) || 'Unable to print stock-out report.')
    }
  }

  function handleDownloadStockOutPdf() {
    if (!stockOutFeed.length) return
    const text = buildStockOutText(stockOutFeed)
    downloadPdf(`stock-out-${new Date().toISOString().slice(0, 10)}.pdf`, buildTextPdf(text))
    flash('Stock-out PDF downloaded.')
  }

  async function handleCreateProduct(data) {
    try {
      const created = await api.createProduct(data)
      setProducts([created, ...products])
      setNewProductBarcode('')
      setBarcode('')
      setScanError('')
      setFeed((f) => [
        {
          key: `${Date.now()}-${created.id}`,
          name: created.name,
          id: created.sku || created.id,
          barcode: created.barcode,
          qty: created.qty,
          newQty: created.qty,
          time: new Date(),
        },
        ...f.slice(0, 14),
      ])
      flash(`Created ${created.name} with ${created.qty} unit(s).`)
      focusBarcode()
    } catch (err) {
      flash(err.message || 'Unable to create product.')
    }
  }

  const stockInScanner = (
    <div className="card scanner-priority-card">
      <div className="panel-head">
        <div>
          <h3>Stock-In Scanner</h3>
          <span className="sub">{sessionUnits} base unit(s) counted or added this session</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="scan-mode-row">
          <button
            type="button"
            className={`scan-mode ${scanMode === 'instant' ? 'active' : ''}`}
            onClick={() => setScanMode('instant')}
          >
            Add Immediately
          </button>
          <button
            type="button"
            className={`scan-mode ${scanMode === 'batch' ? 'active' : ''}`}
            onClick={() => setScanMode('batch')}
          >
            Scan then Confirm
          </button>
        </div>

        <div className="scan-flow">
          <IconScan size={16} />
          <span>
            {scanMode === 'batch'
              ? <>Workflow: set <b>Qty per scan</b>, scan each item, review the pending count, then confirm the whole stock-in batch.</>
              : <>Workflow: set <b>Qty per scan</b>, scan a barcode, then scanner Enter adds stock and refocuses the barcode field.</>}
          </span>
        </div>

        <form className="scan-grid" onSubmit={scan}>
          <div className="field scan-search-field">
            <label><span className="scan-step-no">1</span>Scan Barcode</label>
            <input
              ref={barcodeRef}
              className="input"
              placeholder="Scan barcode or search product"
              value={barcode}
              onChange={(e) => { setBarcode(e.target.value); setStockInUnit(''); setScanError('') }}
              autoFocus
            />
            {barcodeMatches.length > 0 && (
              <div className="scan-suggestions">
                {barcodeMatches.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className="scan-suggestion"
                    onClick={() => {
                      setBarcode(product.barcode || '')
                      setStockInUnit('')
                      setScanError('')
                      focusBarcode()
                    }}
                  >
                    <span>
                      <strong>{product.name}</strong>
                      <small>{product.barcode || 'No barcode'} | {product.category}</small>
                    </span>
                    <span className="badge badge-info">{product.qty} in stock</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="field">
            <label><span className="scan-step-no">2</span>Qty per Scan</label>
            <input className="input" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="field">
            <label><span className="scan-step-no">3</span>Unit per Scan</label>
            <select
              className="select"
              value={selectedStockInUnit ? unitOptionValue(selectedStockInUnit, stockInUnitOptions.indexOf(selectedStockInUnit)) : ''}
              onChange={(e) => setStockInUnit(e.target.value)}
              disabled={!scannedProduct}
            >
              {!scannedProduct ? <option value="">Select product first</option> : null}
              {stockInUnitOptions.map((unit, index) => (
                <option key={unitOptionValue(unit, index)} value={unitOptionValue(unit, index)}>
                  {unit.unit} ({unit.conversion} {scannedProduct?.unit || 'unit'}{Number(unit.conversion) === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" style={{ height: 38 }}>
            <span className="scan-step-no" style={{ background: 'rgba(255,255,255,.3)' }}>4</span>
            Add to Stock
          </button>
        </form>

        {barcode.trim() && (
          <div className={`scan-preview ${scannedProduct ? 'found' : 'missing'}`}>
            {scannedProduct ? (
              <>
                <div>
                  <strong>{scannedProduct.name}</strong>
                  <span>
                    {(selectedStockInUnit?.barcode || barcode.trim() || scannedProduct.barcode) || 'No barcode'} | {selectedStockInUnit?.unit || scannedProduct.unit} | current stock: {scannedProduct.qty} {scannedProduct.unit}
                    {selectedStockInUnit ? ` | +${Number(qty || 1) * Number(selectedStockInUnit.conversion || 1)} ${scannedProduct.unit}` : ''}
                    {pendingById[scannedProduct.id] ? ` | pending: +${pendingById[scannedProduct.id]}` : ''}
                  </span>
                  {selectedStockInUnit ? <small>{unitEquivalentText(scannedProduct, selectedStockInUnit, qty)}</small> : null}
                </div>
                <span className={`badge ${(statusLabel[scannedProduct.status] || statusLabel['in-stock']).badge}`}>
                  {(statusLabel[scannedProduct.status] || statusLabel['in-stock']).text}
                </span>
              </>
            ) : (
              <>
                <div>
                  <strong>Unknown barcode</strong>
                  <span>{barcode.trim()} is not in Product Management yet.</span>
                </div>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setNewProductBarcode(barcode.trim())}
                >
                  Add Product
                </button>
              </>
            )}
          </div>
        )}

        {scanError && (
          <div className="scan-error">
            <span>{scanError}</span>
            {hasUnknownBarcode && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setNewProductBarcode(barcode.trim())}>
                Create Product
              </button>
            )}
          </div>
        )}

        {scanMode === 'batch' && (
          <div className="stock-batch">
            <div className="stock-batch-head">
              <div>
                <strong>Pending Stock-In Batch</strong>
                <span>{batchUnits} base unit(s) counted across {batchItems.length} line(s)</span>
              </div>
              <div className="stock-batch-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={batchItems.length === 0 || confirmingBatch}
                  onClick={() => {
                    setBatchItems([])
                    focusBarcode()
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={batchItems.length === 0 || confirmingBatch}
                  onClick={confirmBatch}
                >
                  {confirmingBatch ? 'Confirming...' : 'Confirm Stock-In'}
                </button>
              </div>
            </div>

            {batchItems.length === 0 ? (
              <div className="stock-batch-empty">Scanned items will wait here until you confirm.</div>
            ) : (
              <div className="stock-batch-list">
                {batchItems.map((item) => (
                  <div className="stock-batch-row" key={`${item.id}-${item.unitKey}`}>
                    <div>
                      <strong>{item.name}</strong>
                      <span>{item.barcode || item.sku} | {item.unit} x {item.qty} | after confirm {item.currentQty + item.baseQty} {item.baseUnit}</span>
                      {item.equivalentText ? <small>{item.equivalentText}</small> : null}
                    </div>
                    <label className="stock-batch-qty">
                      <span className="qty-sign positive">+</span>
                      <span>Qty In</span>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        value={item.qty}
                        onChange={(e) => updateBatchItemQty(item.id, item.unitKey, e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-btn del"
                      title="Remove from batch"
                      onClick={() => setBatchItems((items) => items.filter((row) => !(row.id === item.id && row.unitKey === item.unitKey)))}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="scan-feed">
          <div className="section-sub">{scanMode === 'batch' ? 'Recently Confirmed' : 'Recently Scanned'}</div>
          {feed.length === 0 ? (
            <div className="empty" style={{ padding: '36px 24px' }}>
              <div className="em-icon"><IconScan size={24} /></div>
              <h4>No items scanned yet</h4>
              <p>Scanned items will appear here as a live feed.</p>
            </div>
          ) : (
            feed.map((f) => (
              <div className="scan-feed-item" key={f.key}>
                <span className="stat-icon ic-green" style={{ width: 32, height: 32 }}>
                  <IconCheck size={16} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="prod-name">{f.name}</div>
                  <div className="prod-id">{f.barcode || f.id} | stock now {f.newQty}</div>
                  {f.equivalentText ? <div className="prod-id">{f.equivalentText}</div> : null}
                </div>
                <span className="badge badge-info">+{f.qty} {f.unit || 'unit(s)'}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {f.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )

  const stockOutScanner = (
    <div className="card scanner-priority-card">
      <div className="panel-head">
        <div>
          <h3>Stock-Out Scanner</h3>
          <span className="sub">{stockOutSessionUnits} base unit(s) removed or queued this session</span>
        </div>
        <div className="panel-actions">
          <button type="button" className="btn btn-outline" disabled={!stockOutFeed.length} onClick={handleExportStockOut}>
            <IconDownload size={16} /> Export Sheet
          </button>
          <button type="button" className="btn btn-outline" disabled={!stockOutFeed.length} onClick={handleDownloadStockOutPdf}>
            <IconDownload size={16} /> PDF
          </button>
          <button type="button" className="btn btn-outline" disabled={!stockOutFeed.length} onClick={handlePrintStockOut}>
            <IconPrint size={16} /> Thermal
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="scan-mode-row">
          <button
            type="button"
            className={`scan-mode ${stockOutMode === 'batch' ? 'active' : ''}`}
            onClick={() => setStockOutMode('batch')}
          >
            Scan then Confirm
          </button>
          <button
            type="button"
            className={`scan-mode ${stockOutMode === 'instant' ? 'active' : ''}`}
            onClick={() => setStockOutMode('instant')}
          >
            Remove Immediately
          </button>
        </div>

        <div className="scan-flow">
          <IconScan size={16} />
          <span>
            {stockOutMode === 'batch'
              ? <>Workflow: choose the <b>reason</b>, scan items into a pending list, review counts, then confirm the stock-out.</>
              : <>Workflow: choose the <b>reason</b>, scan a barcode, then Enter immediately subtracts stock.</>}
          </span>
        </div>

        <form className="scan-grid" onSubmit={scanStockOut}>
          <div className="field scan-search-field">
            <label><span className="scan-step-no">1</span>Scan Barcode</label>
            <input
              ref={stockOutRef}
              className="input"
              placeholder="Scan barcode or search product"
              value={stockOutBarcode}
              onChange={(e) => { setStockOutBarcode(e.target.value); setStockOutUnit(''); setStockOutError('') }}
            />
            {stockOutMatches.length > 0 && (
              <div className="scan-suggestions">
                {stockOutMatches.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className="scan-suggestion"
                    onClick={() => {
                      setStockOutBarcode(product.barcode || '')
                      setStockOutUnit('')
                      setStockOutError('')
                      focusStockOutBarcode()
                    }}
                  >
                    <span>
                      <strong>{product.name}</strong>
                      <small>{product.barcode || 'No barcode'} | {product.category}</small>
                    </span>
                    <span className="badge badge-info">{product.qty} in stock</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="field">
            <label><span className="scan-step-no">2</span>Qty Out</label>
            <input className="input" type="number" min="1" value={stockOutQty} onChange={(e) => setStockOutQty(e.target.value)} />
          </div>
          <div className="field">
            <label><span className="scan-step-no">3</span>Unit Out</label>
            <select
              className="select"
              value={selectedStockOutUnit ? unitOptionValue(selectedStockOutUnit, stockOutUnitOptions.indexOf(selectedStockOutUnit)) : ''}
              onChange={(e) => setStockOutUnit(e.target.value)}
              disabled={!stockOutProduct}
            >
              {!stockOutProduct ? <option value="">Select product first</option> : null}
              {stockOutUnitOptions.map((unit, index) => (
                <option key={unitOptionValue(unit, index)} value={unitOptionValue(unit, index)}>
                  {unit.unit} ({unit.conversion} {stockOutProduct?.unit || 'unit'}{Number(unit.conversion) === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label><span className="scan-step-no">4</span>Reason</label>
            <select
              className="input"
              value={stockOutReason}
              onChange={(e) => {
                setStockOutReason(e.target.value)
                if (e.target.value !== 'other') setStockOutNote('')
              }}
            >
              {Object.entries(stockOutReasons).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" style={{ height: 38 }}>
            <span className="scan-step-no" style={{ background: 'rgba(255,255,255,.3)' }}>5</span>
            {stockOutMode === 'batch' ? 'Queue Stock-Out' : 'Remove Stock'}
          </button>
        </form>

        {stockOutReason === 'other' && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Other Reason</label>
            <input
              className="input"
              placeholder="Example: count correction, missing item, supplier pull-out"
              value={stockOutNote}
              onChange={(e) => setStockOutNote(e.target.value)}
            />
          </div>
        )}

        {stockOutBarcode.trim() && (
          <div className={`scan-preview ${stockOutProduct ? 'found' : 'missing'}`}>
            {stockOutProduct ? (
              <>
                <div>
                  <strong>{stockOutProduct.name}</strong>
                  <span>
                    {(selectedStockOutUnit?.barcode || stockOutBarcode.trim() || stockOutProduct.barcode) || 'No barcode'} | {selectedStockOutUnit?.unit || stockOutProduct.unit} | current stock: {stockOutProduct.qty} {stockOutProduct.unit}
                    {selectedStockOutUnit ? ` | -${Number(stockOutQty || 1) * Number(selectedStockOutUnit.conversion || 1)} ${stockOutProduct.unit}` : ''}
                    {pendingStockOutById[stockOutProduct.id] ? ` | pending: -${pendingStockOutById[stockOutProduct.id]}` : ''}
                  </span>
                  {selectedStockOutUnit ? <small>{unitEquivalentText(stockOutProduct, selectedStockOutUnit, stockOutQty)}</small> : null}
                </div>
                <span className="badge badge-info">available {stockOutAvailable(stockOutProduct)}</span>
              </>
            ) : (
              <div>
                <strong>Unknown barcode</strong>
                <span>{stockOutBarcode.trim()} is not in Product Management.</span>
              </div>
            )}
          </div>
        )}

        {stockOutError && <div className="scan-error"><span>{stockOutError}</span></div>}

        {stockOutMode === 'batch' && (
          <div className="stock-batch">
            <div className="stock-batch-head">
              <div>
                <strong>Pending Stock-Out Batch</strong>
                <span>{stockOutBatchUnits} base unit(s) queued across {stockOutBatch.length} line(s)</span>
              </div>
              <div className="stock-batch-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={stockOutBatch.length === 0 || confirmingStockOut}
                  onClick={() => {
                    setStockOutBatch([])
                    focusStockOutBarcode()
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={stockOutBatch.length === 0 || confirmingStockOut}
                  onClick={confirmStockOutBatch}
                >
                  {confirmingStockOut ? 'Confirming...' : 'Confirm Stock-Out'}
                </button>
              </div>
            </div>

            {stockOutBatch.length === 0 ? (
              <div className="stock-batch-empty">Queued stock-outs will wait here until you confirm.</div>
            ) : (
              <div className="stock-batch-list">
                {stockOutBatch.map((item) => (
                  <div className="stock-batch-row" key={`${item.id}-${item.unitKey}`}>
                    <div>
                      <strong>{item.name}</strong>
                  <span>{item.barcode || item.sku} | {item.unit} x {item.qty} | {item.reasonLabel} | after confirm {Math.max(0, item.currentQty - item.baseQty)} {item.baseUnit}</span>
                  {item.equivalentText ? <small>{item.equivalentText}</small> : null}
                    </div>
                    <label className="stock-batch-qty">
                      <span className="qty-sign negative">-</span>
                      <span>Qty Out</span>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        max={Math.max(1, Math.floor((Number(item.currentQty) || 0) / (Number(item.conversion) || 1)))}
                        value={item.qty}
                        onChange={(e) => updateStockOutBatchItemQty(item.id, item.unitKey, e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-btn del"
                      title="Remove from batch"
                      onClick={() => setStockOutBatch((items) => items.filter((row) => !(row.id === item.id && row.unitKey === item.unitKey)))}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="scan-feed">
          <div className="section-sub">Confirmed Stock-Outs</div>
          {stockOutFeed.length === 0 ? (
            <div className="empty" style={{ padding: '36px 24px' }}>
              <div className="em-icon"><IconScan size={24} /></div>
              <h4>No stock-outs yet</h4>
              <p>Confirmed expired, damaged, and other stock-outs will appear here.</p>
            </div>
          ) : (
            stockOutFeed.map((item) => (
              <div className="scan-feed-item" key={item.key}>
                <span className="stat-icon ic-red" style={{ width: 32, height: 32 }}>
                  <IconTrash size={16} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="prod-name">{item.name}</div>
                  <div className="prod-id">{item.barcode || item.id} | {item.reasonLabel} | stock now {item.newQty}</div>
                  {item.equivalentText ? <div className="prod-id">{item.equivalentText}</div> : null}
                </div>
                <span className="badge badge-danger">-{item.qty} {item.unit || 'unit(s)'}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {item.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )

  if (loading) {
    return (
      <>
        <PageHeader title="Inventory Scanner" subtitle="Loading inventory..." />
        <div className="card"><div className="empty"><h4>Loading inventory</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Inventory Scanner" subtitle="Scan barcodes to add stock and monitor inventory health." />
        <div className="card"><div className="empty"><h4>Unable to load inventory</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Inventory Scanner"
        subtitle="Scan stock in, or stock out expired, damaged, and other removed goods with batch review or instant updates."
      />

      <div className="stat-grid cols-3">
        <StatCard label="Total Products" tone="indigo" icon={IconBox} value={totalProducts} foot="active SKUs" />
        <StatCard label="Low Stock Items" tone="amber" icon={IconAlert} value={lowItems} foot="below threshold" />
        <StatCard label="Total Stock Value" tone="green" icon={IconDollar} value={peso(stockValue)} foot="at cost" />
      </div>

      <div className="scan-mode-row analytics-tabs">
        <button
          type="button"
          className={`scan-mode ${inventoryTab === 'stock-in' ? 'active' : ''}`}
          onClick={() => {
            setInventoryTab('stock-in')
            focusBarcode()
          }}
        >
          Stock-In
        </button>
        <button
          type="button"
          className={`scan-mode ${inventoryTab === 'stock-out' ? 'active' : ''}`}
          onClick={() => {
            setInventoryTab('stock-out')
            focusStockOutBarcode()
          }}
        >
          Stock-Out
        </button>
      </div>

      {inventoryTab === 'stock-in' ? stockInScanner : stockOutScanner}

      {newProductBarcode && (
        <ProductModal
          mode="add"
          product={{
            name: '',
            barcode: newProductBarcode,
            category: categories[0] || defaultCategories[0],
            unit: 'Piece',
            qty: Math.max(1, Math.floor(Number(qty) || 1)),
            lowStock: 10,
            price: 0,
          }}
          categories={categories}
          onClose={() => {
            setNewProductBarcode('')
            focusBarcode()
          }}
          onSave={handleCreateProduct}
        />
      )}

      {toast && <div className="toast"><IconCheck size={15} /> {toast}</div>}
    </>
  )
}
