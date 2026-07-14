import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { IconImage, IconPlus, IconTrash } from './Icons'
import { defaultCategories } from '../services/api'

const baseUnitOptions = ['Piece', 'Stick', 'Bottle', 'Sachet', 'Kilogram', 'Liter', 'Pack', 'Box', 'Case', 'Sack', 'Tray', 'Ream', 'Bag', 'Can', 'Jar', 'Roll']
const purchaseUnitOptions = ['Ream', 'Box', 'Case', 'Pack', 'Sack', 'Tray', 'Carton', 'Pouch', 'Bag', 'Bundle', 'Crate']
const unitTemplates = [
  {
    id: 'custom',
    name: 'Custom units',
    description: 'Start blank and enter this product\'s own units.',
    unit: 'Piece',
    purchaseUnit: 'Box',
    conversionQuantity: 1,
    units: [{ unit: 'Piece', conversion: 1 }],
  },
  {
    id: 'cigarette',
    name: 'Cigarette: Ream > Pack > Stick',
    description: '1 ream = 10 packs = 200 sticks.',
    unit: 'Stick',
    purchaseUnit: 'Ream',
    conversionQuantity: 200,
    units: [
      { unit: 'Stick', conversion: 1 },
      { unit: 'Pack', conversion: 20 },
      { unit: 'Ream', conversion: 200 },
    ],
  },
  {
    id: 'case-bottle',
    name: 'Drinks: Case > Bottle',
    description: 'Common bottle setup, editable per supplier.',
    unit: 'Bottle',
    purchaseUnit: 'Case',
    conversionQuantity: 24,
    units: [
      { unit: 'Bottle', conversion: 1 },
      { unit: 'Case', conversion: 24 },
    ],
  },
  {
    id: 'box-piece',
    name: 'Boxed goods: Box > Piece',
    description: 'For items sold by piece but bought by box.',
    unit: 'Piece',
    purchaseUnit: 'Box',
    conversionQuantity: 12,
    units: [
      { unit: 'Piece', conversion: 1 },
      { unit: 'Box', conversion: 12 },
    ],
  },
  {
    id: 'sack-kilo',
    name: 'Rice/Grain: Sack > Kilogram',
    description: 'For sacks divided into kilos.',
    unit: 'Kilogram',
    purchaseUnit: 'Sack',
    conversionQuantity: 25,
    units: [
      { unit: 'Kilogram', conversion: 1 },
      { unit: 'Sack', conversion: 25 },
    ],
  },
]

const blank = {
  name: '',
  barcode: '',
  category: defaultCategories[0],
  unit: 'Piece',
  purchaseUnit: 'Box',
  conversionQuantity: 1,
  initialStock: 0,
  lowStock: 10,
  cost: 0,
  profitMargin: 0,
  price: 0,
  isPriceManual: false,
  hasMultipleUnits: false,
  unitTemplate: 'custom',
}

function normalizeSellingUnits(rawUnits = [], fallback = {}) {
  const parsedUnits = Array.isArray(rawUnits) ? rawUnits : []
  const baseUnit = String(fallback.unit || 'Piece').trim() || 'Piece'

  if (parsedUnits.length > 0) {
    return parsedUnits.map((unit) => ({
      barcode: String(unit.barcode || '').trim(),
      unit: String(unit.unit || '').trim() || baseUnit,
      conversion: Number(unit.conversion) > 0 ? Number(unit.conversion) : 1,
      price: Number(unit.price) || 0,
      isPriceManual: Boolean(unit.isPriceManual),
    }))
  }

  return [{
    barcode: String(fallback.barcode || '').trim(),
    unit: baseUnit,
    conversion: 1,
    price: 0,
    isPriceManual: false,
  }]
}

function normalizeUnitKey(value) {
  return String(value || '').trim().toLowerCase()
}

function unitLabel(value, quantity = 2) {
  const label = String(value || 'unit').trim() || 'unit'
  const irregular = {
    box: 'Boxes',
    piece: 'Pieces',
    kilo: 'Kilos',
    kilogram: 'Kilograms',
    tray: 'Trays',
  }
  if (Number(quantity) === 1 || /s$/i.test(label)) return label
  const mapped = irregular[normalizeUnitKey(label)]
  if (mapped) return mapped
  return `${label}s`
}

function stockInputLabel(form, isEdit = false) {
  if (isEdit) return `Total Stock (${unitLabel(form.unit)})`
  if (!form.hasMultipleUnits) return 'Starting Stock'
  return `Starting Stock (${unitLabel(form.purchaseUnit)})`
}

function stockInputHelp(form, baseInventoryPreview, isEdit = false) {
  if (isEdit) return `${baseInventoryPreview} ${unitLabel(form.unit, baseInventoryPreview)} currently in inventory`
  if (!form.hasMultipleUnits) return ''
  const stockCount = Number(form.initialStock) || 0
  const purchaseUnits = unitLabel(form.purchaseUnit, stockCount)
  const baseUnits = unitLabel(form.unit, baseInventoryPreview)
  return `${stockCount} ${purchaseUnits} received = ${baseInventoryPreview} ${baseUnits} in inventory`
}

function defaultPurchaseConversion(unit, purchaseUnit, currentConversion) {
  const baseUnit = normalizeUnitKey(unit)
  const buyingUnit = normalizeUnitKey(purchaseUnit)
  const conversion = Number(currentConversion)
  if (baseUnit === 'stick' && buyingUnit === 'ream' && (!Number.isFinite(conversion) || conversion <= 1)) return 200
  return currentConversion
}

function ensurePurchaseUnitRow(nextForm, currentRows = []) {
  if (!nextForm.hasMultipleUnits) return currentRows

  const purchaseUnit = String(nextForm.purchaseUnit || '').trim()
  const baseUnit = String(nextForm.unit || 'Piece').trim() || 'Piece'
  const conversionQuantity = Number(nextForm.conversionQuantity)
  if (!purchaseUnit || normalizeUnitKey(purchaseUnit) === normalizeUnitKey(baseUnit) || !Number.isFinite(conversionQuantity) || conversionQuantity <= 1) {
    return currentRows
  }

  const purchasePrice = deriveSellingPrice(Number(nextForm.cost), Number(nextForm.profitMargin), conversionQuantity, conversionQuantity)
  const existingIndex = currentRows.findIndex((row, index) => (
    index > 0
    && (
      normalizeUnitKey(row.unit) === normalizeUnitKey(purchaseUnit)
      || Number(row.conversion) === conversionQuantity
    )
  ))

  if (existingIndex >= 0) {
    return currentRows.map((row, index) => {
      if (index !== existingIndex) return row
      return {
        ...row,
        unit: purchaseUnit,
        conversion: conversionQuantity,
        price: row.isPriceManual ? row.price : purchasePrice,
      }
    })
  }

  return [
    ...currentRows,
    {
      barcode: '',
      unit: purchaseUnit,
      conversion: conversionQuantity,
      price: purchasePrice,
      isPriceManual: false,
    },
  ]
}

function ensureSellingRows(nextForm, currentRows = []) {
  return ensurePurchaseUnitRow(nextForm, currentRows)
}

function detectUnitTemplate({ unit, purchaseUnit, conversionQuantity, sellingUnits = [] }) {
  const baseKey = normalizeUnitKey(unit)
  const purchaseKey = normalizeUnitKey(purchaseUnit)
  const conversion = Number(conversionQuantity)
  const rowKeys = sellingUnits
    .map((row) => `${normalizeUnitKey(row.unit)}:${Number(row.conversion) || 1}`)
    .sort()
    .join('|')

  const match = unitTemplates.find((template) => {
    if (template.id === 'custom') return false
    const templateRows = template.units
      .map((row) => `${normalizeUnitKey(row.unit)}:${Number(row.conversion) || 1}`)
      .sort()
      .join('|')

    return (
      normalizeUnitKey(template.unit) === baseKey
      && normalizeUnitKey(template.purchaseUnit) === purchaseKey
      && Number(template.conversionQuantity) === conversion
      && templateRows === rowKeys
    )
  })

  return match?.id || 'custom'
}

function inferUnitStructure(product, rawSellingUnits = []) {
  const savedBaseUnit = String(product?.unit || '').trim()
  const savedPurchaseUnit = String(product?.purchaseUnit || product?.purchase_unit || '').trim()
  const savedConversion = Number(product?.conversionQuantity ?? product?.conversion_quantity)
  const parsedUnits = Array.isArray(rawSellingUnits)
    ? rawSellingUnits
      .map((row) => ({
        unit: String(row?.unit || '').trim(),
        conversion: Number(row?.conversion) > 0 ? Number(row.conversion) : 1,
      }))
      .filter((row) => row.unit)
    : []

  const baseRow = parsedUnits.find((row) => row.conversion === 1)
  const largestRow = parsedUnits.reduce((largest, row) => (
    row.conversion > (largest?.conversion || 0) ? row : largest
  ), null)
  const hasMultipleRows = parsedUnits.length > 1

  const baseUnit = baseRow?.unit || savedBaseUnit || 'Piece'
  const purchaseUnit = savedPurchaseUnit || (hasMultipleRows && largestRow?.conversion > 1 ? largestRow.unit : '') || 'Box'
  const conversionQuantity = Number.isFinite(savedConversion) && savedConversion > 1
    ? savedConversion
    : (hasMultipleRows && largestRow?.conversion > 1 ? largestRow.conversion : 1)

  return { baseUnit, purchaseUnit, conversionQuantity }
}

function buildInitialForm(product, categories, isEdit = false) {
  const rawSellingUnits = product?.sellingUnits || product?.selling_units || []
  const { baseUnit, purchaseUnit, conversionQuantity } = inferUnitStructure(product, rawSellingUnits)
  const costValue = Number(product?.cost) || Number(product?.price) || 0
  const marginValue = Number(product?.profitMargin) || 0
  const hasSellingUnitRows = Array.isArray(rawSellingUnits) && rawSellingUnits.length > 1
  const isMultipleUnits = Boolean((product?.hasMultipleUnits ?? product?.has_multiple_units) || hasSellingUnitRows || conversionQuantity > 1)
  const defaultPrice = deriveSellingPrice(costValue, marginValue, 1, Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1)
  const initialSellingUnits = normalizeSellingUnits(rawSellingUnits, { barcode: product?.barcode || '', unit: baseUnit })
    .map((unit, index) => (index === 0 ? { ...unit, price: defaultPrice, isPriceManual: false } : unit))

  const preparedSellingUnits = ensureSellingRows({
    hasMultipleUnits: isMultipleUnits,
    purchaseUnit,
    unit: baseUnit,
    conversionQuantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    cost: costValue,
    profitMargin: marginValue,
  }, initialSellingUnits)

  return {
    ...blank,
    ...(product || {}),
    name: String(product?.name || '').trim(),
    barcode: String(product?.barcode || '').trim(),
    category: String(product?.category || categories[0] || '').trim() || blank.category,
    unit: baseUnit,
    purchaseUnit,
    conversionQuantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    initialStock: isEdit
      ? (Number(product?.qty ?? product?.quantity) || 0)
      : (Number(product?.initialStock ?? product?.qty ?? product?.quantity ?? 0) || 0),
    lowStock: Number(product?.lowStock ?? product?.min_stock ?? blank.lowStock) || 0,
    cost: costValue,
    profitMargin: marginValue,
    price: defaultPrice,
    isPriceManual: false,
    hasMultipleUnits: isMultipleUnits,
    unitTemplate: isMultipleUnits ? detectUnitTemplate({
      unit: baseUnit,
      purchaseUnit,
      conversionQuantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
      sellingUnits: preparedSellingUnits,
    }) : 'custom',
    sellingUnits: preparedSellingUnits,
  }
}

function formatPriceInput(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00'
}

function deriveBaseUnitCost(costValue, conversionQuantity) {
  if (!Number.isFinite(costValue) || costValue <= 0) return 0
  const normalizedConversion = Number(conversionQuantity)
  if (!Number.isFinite(normalizedConversion) || normalizedConversion <= 0) return 0
  return costValue / normalizedConversion
}

function deriveSellingPrice(costValue, profitMargin, conversionValue, conversionQuantity) {
  const baseUnitCost = deriveBaseUnitCost(costValue, conversionQuantity)
  if (!Number.isFinite(baseUnitCost) || baseUnitCost <= 0) return 0
  const normalizedConversion = Number(conversionValue)
  if (!Number.isFinite(normalizedConversion) || normalizedConversion <= 0) return 0
  const normalizedMargin = Number(profitMargin)
  if (!Number.isFinite(normalizedMargin) || normalizedMargin < 0) return 0
  return Number((baseUnitCost * normalizedConversion * (1 + normalizedMargin / 100)).toFixed(2))
}

function resolveInventoryBaseQty(initialStock, conversionQuantity) {
  const normalizedInitialStock = Number(initialStock) || 0
  const normalizedConversion = Number(conversionQuantity) > 0 ? Number(conversionQuantity) : 1
  return normalizedInitialStock * normalizedConversion
}

export default function ProductModal({ mode, product, categories = defaultCategories, onClose, onSave }) {
  const isEdit = mode === 'edit'
  const initialForm = buildInitialForm(product, categories, isEdit)
  const [form, setForm] = useState(initialForm)
  const [sellingUnits, setSellingUnits] = useState(initialForm.sellingUnits || [])
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(product?.imageUrl || '')
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)
  const objectUrlRef = useRef('')

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  function updateSellingRows(nextForm, currentRows = sellingUnits) {
    const baseUnitPrice = deriveSellingPrice(Number(nextForm.cost), Number(nextForm.profitMargin), 1, Number(nextForm.conversionQuantity))

    const normalizedRows = currentRows.map((row, index) => {
      if (index === 0) {
        return {
          ...row,
          unit: String(nextForm.unit || 'Piece').trim() || 'Piece',
          conversion: 1,
          price: baseUnitPrice,
          isPriceManual: Boolean(nextForm.isPriceManual),
        }
      }

      if (!row.isPriceManual) {
        const computedPrice = deriveSellingPrice(Number(nextForm.cost), Number(nextForm.profitMargin), Number(row.conversion), Number(nextForm.conversionQuantity))
        return { ...row, price: computedPrice, isPriceManual: false }
      }

      return row
    })

    return { normalizedRows: ensureSellingRows(nextForm, normalizedRows), baseUnitPrice }
  }

  function setFormValue(key, value) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (['unit', 'purchaseUnit', 'conversionQuantity'].includes(key)) {
        next.unitTemplate = 'custom'
      }
      if (key === 'unit' || key === 'purchaseUnit' || key === 'hasMultipleUnits') {
        next.conversionQuantity = defaultPurchaseConversion(next.unit, next.purchaseUnit, next.conversionQuantity)
      }

      if (key === 'barcode') {
        setSellingUnits((current) => current.map((row, index) => (index === 0 ? { ...row, barcode: String(value || '').trim() } : row)))
      }

      if (key === 'unit') {
        setSellingUnits((current) => ensureSellingRows(next, current.map((row, index) => (index === 0 ? { ...row, unit: String(value || '').trim() || 'Piece', conversion: 1 } : row))))
      }

      if (key === 'cost' || key === 'profitMargin' || key === 'conversionQuantity') {
        const { normalizedRows, baseUnitPrice } = updateSellingRows(next)
        setSellingUnits(normalizedRows)
        if (!next.isPriceManual) {
          next.price = baseUnitPrice
        }
      }

      if (key === 'hasMultipleUnits' && !value) {
        setSellingUnits((current) => current.map((row, index) => (index === 0 ? {
          ...row,
          unit: String(next.unit || 'Piece').trim() || 'Piece',
          conversion: 1,
          price: deriveSellingPrice(Number(next.cost), Number(next.profitMargin), 1, Number(next.conversionQuantity)),
          isPriceManual: false,
        } : row)))
      }

      if ((key === 'hasMultipleUnits' && value) || key === 'purchaseUnit') {
        setSellingUnits((current) => ensureSellingRows(next, current))
      }

      return next
    })
  }

  function setFormNumberValue(key, value) {
    if (typeof value === 'string' && value.trim() === '') {
      setFormValue(key, '')
      return
    }

    const numericValue = Number(value)
    setFormValue(key, Number.isFinite(numericValue) ? numericValue : 0)
  }

  const set = (k) => (e) => setFormValue(k, e.target.value)

  function selectImage(file) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      alert('Please upload a JPEG, PNG, or WEBP image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Product image must be 5MB or smaller.')
      return
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = URL.createObjectURL(file)
    setImageFile(file)
    setImagePreview(objectUrlRef.current)
  }

  function handleDrop(e) {
    e.preventDefault()
    setIsDragging(false)
    selectImage(e.dataTransfer.files?.[0])
  }

  function addSellingUnit() {
    const basePrice = deriveSellingPrice(Number(form.cost), Number(form.profitMargin), 1, Number(form.conversionQuantity))
    setFormValue('unitTemplate', 'custom')

    setSellingUnits((current) => [
      ...current,
      {
        barcode: '',
        unit: form.unit || 'Piece',
        conversion: 1,
        price: basePrice,
        isPriceManual: false,
      },
    ])
  }

  function removeSellingUnit(index) {
    if (sellingUnits.length === 1) return
    setFormValue('unitTemplate', 'custom')
    setSellingUnits((current) => current.filter((_, idx) => idx !== index))
  }

  function updateSellingUnit(index, key, value) {
    setFormValue('unitTemplate', 'custom')
    setSellingUnits((current) => current.map((row, idx) => {
      if (idx !== index) return row
      if (key === 'price') {
        return {
          ...row,
          price: value === '' ? '' : Number(value) || 0,
          isPriceManual: true,
        }
      }
      if (key === 'conversion') {
        const normalizedConversion = value === '' ? '' : (Number(value) > 0 ? Number(value) : 1)
        return {
          ...row,
          conversion: normalizedConversion,
          price: normalizedConversion === ''
            ? row.price
            : deriveSellingPrice(Number(form.cost), Number(form.profitMargin), normalizedConversion, Number(form.conversionQuantity)),
          isPriceManual: false,
        }
      }
      return { ...row, [key]: value }
    }))
  }

  function applyUnitTemplate(templateId) {
    const template = unitTemplates.find((item) => item.id === templateId)
    if (!template) return

    if (template.id === 'custom') {
      setFormValue('unitTemplate', 'custom')
      return
    }

    const nextForm = {
      ...form,
      hasMultipleUnits: true,
      unitTemplate: template.id,
      unit: template.unit,
      purchaseUnit: template.purchaseUnit,
      conversionQuantity: template.conversionQuantity,
    }

    const rowsByUnit = new Map(sellingUnits.map((row) => [normalizeUnitKey(row.unit), row]))
    const rowsByConversion = new Map(sellingUnits.map((row) => [Number(row.conversion) || 1, row]))
    const templateRows = template.units.map((templateUnit, index) => {
      const existing = rowsByUnit.get(normalizeUnitKey(templateUnit.unit)) || rowsByConversion.get(Number(templateUnit.conversion) || 1)
      return {
        barcode: index === 0 ? String(form.barcode || existing?.barcode || '').trim() : String(existing?.barcode || '').trim(),
        unit: templateUnit.unit,
        conversion: templateUnit.conversion,
        price: existing?.isPriceManual
          ? existing.price
          : deriveSellingPrice(Number(form.cost), Number(form.profitMargin), Number(templateUnit.conversion), Number(template.conversionQuantity)),
        isPriceManual: Boolean(existing?.isPriceManual),
      }
    })

    const { normalizedRows, baseUnitPrice } = updateSellingRows(nextForm, templateRows)
    setForm({ ...nextForm, price: nextForm.isPriceManual ? nextForm.price : baseUnitPrice })
    setSellingUnits(normalizedRows)
  }

  function submit() {
    const costValue = Number(form.cost)
    const marginValue = Number(form.profitMargin)
    const conversionQuantity = Number(form.conversionQuantity)
    const initialStock = Number(form.initialStock)
    const basePrice = deriveSellingPrice(costValue, marginValue, 1, conversionQuantity)

    if (!form.name.trim()) { alert('Product name is required.'); return }
    if (!String(form.category || '').trim()) { alert('Category is required.'); return }
    if (!String(form.unit || '').trim()) { alert('Base unit is required.'); return }
    if (costValue < 0) { alert('Product cost must be 0 or greater.'); return }
    if (!Number.isFinite(marginValue) || marginValue < 0) { alert('Desired profit margin must be 0 or greater.'); return }
    if (!Number.isFinite(initialStock) || initialStock < 0) { alert('Initial stock must be 0 or greater.'); return }
    if (!Number.isFinite(Number(form.lowStock)) || Number(form.lowStock) < 0) { alert('Restock value must be 0 or greater.'); return }

    if (!form.hasMultipleUnits) {
      if (!String(form.barcode || '').trim()) { alert('Barcode is required for single-unit products.'); return }
    } else {
      if (!String(form.purchaseUnit || '').trim()) { alert('Purchase unit is required.'); return }
      if (!Number.isFinite(conversionQuantity) || conversionQuantity <= 1) { alert('Units per purchase unit must be greater than 1 for multi-unit products.'); return }
      if (normalizeUnitKey(form.purchaseUnit) === normalizeUnitKey(form.unit)) { alert('Purchase unit must be larger than the smallest inventory unit.'); return }
    }

    const submitSellingUnits = ensureSellingRows(form, sellingUnits)
    const unitRows = form.hasMultipleUnits
      ? submitSellingUnits.map((row) => ({
        barcode: String(row.barcode || '').trim(),
        unit: String(row.unit || '').trim(),
        conversion: Number(row.conversion) > 0 ? Number(row.conversion) : 1,
        price: Number(row.price) || 0,
        isPriceManual: Boolean(row.isPriceManual),
      }))
      : [{
        barcode: String(form.barcode || '').trim(),
        unit: String(form.unit || '').trim(),
        conversion: 1,
        price: basePrice,
        isPriceManual: false,
      }]

    const normalizedSellingUnits = unitRows.filter((row) => row.barcode || row.unit || row.conversion || row.price)

    const duplicateBarcodes = normalizedSellingUnits.map((row) => row.barcode).filter(Boolean)
    const hasDuplicateBarcode = duplicateBarcodes.some((barcode, index) => duplicateBarcodes.indexOf(barcode) !== index)
    if (hasDuplicateBarcode) { alert('Selling unit barcodes must be unique.'); return }

    const emptySellingUnit = normalizedSellingUnits.find((row) => !row.unit)
    if (emptySellingUnit) { alert('Selling unit names cannot be empty.'); return }

    const invalidPrice = normalizedSellingUnits.find((row) => Number(row.price) <= 0)
    if (form.hasMultipleUnits && invalidPrice) { alert('Selling price must be greater than zero.'); return }

    if (form.hasMultipleUnits && !normalizedSellingUnits.every((row) => Number(row.price) > 0)) {
      alert('Selling price must be greater than zero.');
      return
    }

    // Starting stock is only used when the product is created. Inventory can
    // change independently afterwards, so an ordinary details edit must never
    // recalculate or overwrite the live quantity.
    const baseInventory = isEdit
      ? Math.max(0, Number(product?.qty ?? product?.quantity) || 0)
      : resolveInventoryBaseQty(initialStock, conversionQuantity)
    const savedInitialStock = isEdit
      ? Math.max(0, Number(product?.initialStock ?? product?.initial_stock) || 0)
      : initialStock
    const baseBarcode = String(normalizedSellingUnits[0]?.barcode || '').trim()

    onSave({
      ...form,
      barcode: baseBarcode,
      qty: baseInventory,
      initialStock: savedInitialStock,
      lowStock: Number(form.lowStock) || 0,
      cost: costValue,
      profitMargin: marginValue,
      price: basePrice,
      purchaseUnit: String(form.purchaseUnit || '').trim(),
      conversionQuantity: form.hasMultipleUnits ? conversionQuantity : 1,
      hasMultipleUnits: Boolean(form.hasMultipleUnits),
      sellingUnits: normalizedSellingUnits,
      imageFile,
    })
  }

  const baseUnitCost = Number(form.conversionQuantity) > 0 ? Number(form.cost) / Number(form.conversionQuantity) : Number(form.cost)
  const retailPrice = deriveSellingPrice(Number(form.cost), Number(form.profitMargin), 1, Number(form.conversionQuantity))
  const hasSamePurchaseAndBaseUnit = form.hasMultipleUnits && normalizeUnitKey(form.purchaseUnit) === normalizeUnitKey(form.unit)
  const conversionText = form.hasMultipleUnits && form.purchaseUnit && form.unit && Number(form.conversionQuantity) > 0
    ? `1 ${form.purchaseUnit || 'Purchase Unit'} = ${Number(form.conversionQuantity) || 0} ${unitLabel(form.unit, Number(form.conversionQuantity))}`
    : ''
  const baseInventoryPreview = isEdit
    ? Math.max(0, Number(form.initialStock) || 0)
    : resolveInventoryBaseQty(Number(form.initialStock), Number(form.conversionQuantity))
  const selectableBaseUnits = Array.from(new Set([...baseUnitOptions, form.unit].filter(Boolean)))
  const selectablePurchaseUnits = Array.from(new Set([
    ...purchaseUnitOptions,
    ...baseUnitOptions,
    ...sellingUnits.map((row) => row.unit),
    form.purchaseUnit,
  ].filter(Boolean)))

  return (
    <Modal
      title={isEdit ? 'Edit Product' : 'Add New Product'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>
            {isEdit ? 'Save Changes' : 'Add Product'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field span-2">
          <label>Product Image</label>
          <button
            type="button"
            className={`img-drop ${isDragging ? 'dragging' : ''} ${imagePreview ? 'has-image' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            {imagePreview ? (
              <>
                <img src={imagePreview} alt={`${form.name || 'Product'} preview`} />
                <span>{imageFile ? imageFile.name : 'Click or drop to replace image'}</span>
              </>
            ) : (
              <>
                <div className="di"><IconImage size={20} /></div>
                Drag an image here, or click to upload
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => selectImage(e.target.files?.[0])}
          />
        </div>

        <div className="field">
          <label>Product Name</label>
          <input className="input" placeholder="e.g. Coffee 3-in-1" value={form.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label>Category</label>
          <select className="select" value={form.category} onChange={set('category')}>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        {!form.hasMultipleUnits ? (
          <div className="field">
            <label>Base Unit</label>
            <select className="select" value={form.unit} onChange={set('unit')}>
              {selectableBaseUnits.map((u) => <option key={u}>{u}</option>)}
            </select>
          </div>
        ) : null}

        <div className="field">
          <label>{stockInputLabel(form, isEdit)}</label>
          <input className="input" type="number" min="0" value={form.initialStock} onChange={(e) => setFormValue('initialStock', e.target.value)} disabled={isEdit} />
          {isEdit ? <small>Current inventory is managed from Inventory Scanner and is preserved when product details are edited.</small> : null}
          {form.hasMultipleUnits || isEdit ? (
            <small style={{ marginTop: 2 }}>
              {stockInputHelp(form, baseInventoryPreview, isEdit)}
            </small>
          ) : null}
        </div>

        {!form.hasMultipleUnits ? (
          <div className="field">
            <label>Barcode</label>
            <input className="input" placeholder="Barcode" value={form.barcode} onChange={set('barcode')} />
          </div>
        ) : null}

        <div className="field">
          <label>{form.hasMultipleUnits ? `Purchase Cost per ${form.purchaseUnit || 'Purchase Unit'}` : `Cost per ${form.unit || 'Unit'}`}</label>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={form.cost}
            onChange={(e) => setFormNumberValue('cost', e.target.value)}
            onBlur={(e) => setFormValue('cost', formatPriceInput(e.target.value))}
          />
        </div>

        <div className="field">
          <label>Desired Profit Margin (%)</label>
          <input
            className="input"
            type="number"
            min="0"
            max="99.99"
            step="0.01"
            value={form.profitMargin}
            onChange={(e) => setFormNumberValue('profitMargin', e.target.value)}
            onBlur={(e) => setFormValue('profitMargin', formatPriceInput(e.target.value))}
          />
        </div>

        <div className="field">
          <label>Restock Value</label>
          <input className="input" type="number" min="0" value={form.lowStock} onChange={set('lowStock')} />
        </div>

        <div className="field span-2">
          <label>Inventory Preview</label>
          <div className="table-wrap" style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            <table className="data" style={{ width: '100%' }}>
              <tbody>
                {form.hasMultipleUnits ? (
                  <tr><td><strong>Purchase Conversion</strong></td><td>{conversionText || '-'}</td></tr>
                ) : null}
                <tr><td><strong>Total Base Stock</strong></td><td>{baseInventoryPreview} {unitLabel(form.unit, baseInventoryPreview)}</td></tr>
                <tr><td><strong>Cost per {form.unit || 'Base Unit'}</strong></td><td>{baseUnitCost > 0 ? `PHP ${baseUnitCost.toFixed(2)}` : '-'}</td></tr>
                <tr><td><strong>Retail Price per {form.unit || 'Base Unit'}</strong></td><td>{retailPrice > 0 ? `PHP ${retailPrice.toFixed(2)}` : '-'}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="field span-2">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <input type="checkbox" checked={Boolean(form.hasMultipleUnits)} onChange={(e) => setFormValue('hasMultipleUnits', e.target.checked)} />
            Product has Multiple Selling Units
          </label>
        </div>

        {form.hasMultipleUnits ? (
          <>
            <div className="field span-2">
              <label>Unit Template</label>
              <select className="select" value={form.unitTemplate || 'custom'} onChange={(e) => applyUnitTemplate(e.target.value)}>
                {unitTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <small>{unitTemplates.find((template) => template.id === (form.unitTemplate || 'custom'))?.description}</small>
            </div>

            <div className="field span-2">
              <label>Largest Stock Unit</label>
              <input
                className="input"
                list="largest-unit-options"
                placeholder="e.g. Ream"
                value={form.purchaseUnit}
                onChange={set('purchaseUnit')}
              />
              <datalist id="largest-unit-options">
                {selectablePurchaseUnits.map((u) => <option key={u} value={u} />)}
              </datalist>
              {hasSamePurchaseAndBaseUnit ? (
                <small>Pick a template or set a larger purchase unit so stock can convert correctly.</small>
              ) : null}
            </div>

            <div className="field">
              <label>Smallest Inventory Unit</label>
              <select className="select" value={form.unit} onChange={set('unit')}>
                {selectableBaseUnits.map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{form.unit ? `${unitLabel(form.unit)} inside 1 ${form.purchaseUnit || 'Purchase Unit'}` : 'Units per Purchase Unit'}</label>
              <input className="input" type="number" min="1" value={form.conversionQuantity} onChange={(e) => setFormNumberValue('conversionQuantity', e.target.value)} />
              {conversionText ? <small style={{ display: 'block', marginTop: 6 }}>{conversionText}</small> : null}
            </div>

            <div className="field span-2">
              <label>Selling Units & Barcodes</label>
              <div className="table-wrap" style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table className="data" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Barcode</th>
                      <th>Unit</th>
                      <th>{unitLabel(form.unit)} per Unit</th>
                      <th>Selling Price</th>
                      <th style={{ width: 48 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellingUnits.map((row, index) => (
                      <tr key={index}>
                        <td>
                          <input
                            className="input"
                            placeholder="Barcode"
                            value={row.barcode}
                            onChange={(e) => updateSellingUnit(index, 'barcode', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            placeholder="Unit"
                            value={row.unit}
                            onChange={(e) => updateSellingUnit(index, 'unit', e.target.value)}
                            readOnly={index === 0}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min="1"
                            value={row.conversion}
                            onChange={(e) => updateSellingUnit(index, 'conversion', e.target.value)}
                            readOnly={index === 0}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={row.price}
                            onChange={(e) => updateSellingUnit(index, 'price', e.target.value)}
                          />
                        </td>
                        <td>
                          <button className="icon-btn del" onClick={() => removeSellingUnit(index)} title="Remove selling unit" disabled={sellingUnits.length === 1}>
                            <IconTrash size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn btn-outline btn-sm" onClick={addSellingUnit} style={{ marginTop: 8 }}>
                <IconPlus size={14} /> Add Selling Unit
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
