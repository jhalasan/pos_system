import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { IconImage, IconPlus, IconTrash } from './Icons'
import { defaultCategories } from '../services/api'

const baseUnitOptions = ['Piece', 'Bottle', 'Sachet', 'Kilogram', 'Liter', 'Pack', 'Box', 'Case', 'Sack', 'Tray']
const purchaseUnitOptions = ['Box', 'Case', 'Pack', 'Sack', 'Tray', 'Carton', 'Pouch']

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

function buildInitialForm(product, categories) {
  const baseUnit = String(product?.unit || 'Piece').trim() || 'Piece'
  const purchaseUnit = String(product?.purchaseUnit || product?.purchase_unit || 'Box').trim() || 'Box'
  const conversionQuantity = Number(product?.conversionQuantity ?? product?.conversion_quantity ?? 1)
  const costValue = Number(product?.cost) || Number(product?.price) || 0
  const marginValue = Number(product?.profitMargin) || 0
  const isMultipleUnits = Boolean(product?.hasMultipleUnits ?? product?.has_multiple_units ?? false)
  const defaultPrice = deriveSellingPrice(costValue, marginValue, 1, Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1)
  const initialSellingUnits = normalizeSellingUnits(product?.sellingUnits || product?.selling_units || [], { barcode: product?.barcode || '', unit: baseUnit })
    .map((unit, index) => (index === 0 ? { ...unit, price: defaultPrice, isPriceManual: false } : unit))

  return {
    ...blank,
    ...(product || {}),
    name: String(product?.name || '').trim(),
    barcode: String(product?.barcode || '').trim(),
    category: String(product?.category || categories[0] || '').trim() || blank.category,
    unit: baseUnit,
    purchaseUnit,
    conversionQuantity: Number.isFinite(conversionQuantity) && conversionQuantity > 0 ? conversionQuantity : 1,
    initialStock: Number(product?.initialStock ?? product?.qty ?? product?.quantity ?? 0) || 0,
    lowStock: Number(product?.lowStock ?? product?.min_stock ?? blank.lowStock) || 0,
    cost: costValue,
    profitMargin: marginValue,
    price: defaultPrice,
    isPriceManual: false,
    hasMultipleUnits: isMultipleUnits,
    sellingUnits: initialSellingUnits,
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
  const initialForm = buildInitialForm(product, categories)
  const [form, setForm] = useState(initialForm)
  const [sellingUnits, setSellingUnits] = useState(initialForm.sellingUnits || [])
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(product?.imageUrl || '')
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)
  const objectUrlRef = useRef('')

  const isEdit = mode === 'edit'

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

    return { normalizedRows, baseUnitPrice }
  }

  function setFormValue(key, value) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }

      if (key === 'barcode') {
        setSellingUnits((current) => current.map((row, index) => (index === 0 ? { ...row, barcode: String(value || '').trim() } : row)))
      }

      if (key === 'unit') {
        setSellingUnits((current) => current.map((row, index) => (index === 0 ? { ...row, unit: String(value || '').trim() || 'Piece', conversion: 1 } : row)))
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

      return next
    })
  }

  function setFormNumberValue(key, value) {
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
    setSellingUnits((current) => current.filter((_, idx) => idx !== index))
  }

  function updateSellingUnit(index, key, value) {
    setSellingUnits((current) => current.map((row, idx) => {
      if (idx !== index) return row
      if (key === 'price') {
        return { ...row, price: Number(value) || 0, isPriceManual: true }
      }
      if (key === 'conversion') {
        const normalizedConversion = Number(value) > 0 ? Number(value) : 1
        return {
          ...row,
          conversion: normalizedConversion,
          price: deriveSellingPrice(Number(form.cost), Number(form.profitMargin), normalizedConversion, Number(form.conversionQuantity)),
          isPriceManual: false,
        }
      }
      return { ...row, [key]: value }
    }))
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
    if (costValue < 0) { alert('Cost of goods sold must be 0 or greater.'); return }
    if (!Number.isFinite(marginValue) || marginValue < 0) { alert('Desired profit margin must be 0 or greater.'); return }
    if (!Number.isFinite(initialStock) || initialStock < 0) { alert('Initial stock must be 0 or greater.'); return }
    if (!Number.isFinite(Number(form.lowStock)) || Number(form.lowStock) < 0) { alert('Critical stock must be 0 or greater.'); return }

    if (!form.hasMultipleUnits) {
      if (!String(form.barcode || '').trim()) { alert('Barcode is required for single-unit products.'); return }
    } else {
      if (!String(form.purchaseUnit || '').trim()) { alert('Purchase unit is required.'); return }
      if (!Number.isFinite(conversionQuantity) || conversionQuantity <= 0) { alert('Units per purchase unit must be greater than zero.'); return }
    }

    const unitRows = form.hasMultipleUnits
      ? sellingUnits.map((row) => ({
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

    const baseInventory = resolveInventoryBaseQty(initialStock, conversionQuantity)
    const baseBarcode = String(normalizedSellingUnits[0]?.barcode || '').trim()

    onSave({
      ...form,
      barcode: baseBarcode,
      qty: baseInventory,
      initialStock,
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
  const conversionText = form.hasMultipleUnits && form.purchaseUnit && form.unit && Number(form.conversionQuantity) > 0
    ? `1 ${form.purchaseUnit || 'Purchase Unit'} = ${Number(form.conversionQuantity) || 0} ${form.unit || 'Base Unit'}`
    : ''

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
        <div className="field">
          <label>Base Unit</label>
          <select className="select" value={form.unit} onChange={set('unit')}>
            {baseUnitOptions.map((u) => <option key={u}>{u}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Initial Stock</label>
          <input className="input" type="number" min="0" value={form.initialStock} onChange={(e) => setFormValue('initialStock', e.target.value)} />
        </div>

        {!form.hasMultipleUnits ? (
          <div className="field">
            <label>Barcode</label>
            <input className="input" placeholder="Barcode" value={form.barcode} onChange={set('barcode')} />
          </div>
        ) : null}

        <div className="field">
          <label>Cost of Goods Sold</label>
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
          <label>Critical Stock</label>
          <input className="input" type="number" min="0" value={form.lowStock} onChange={set('lowStock')} />
        </div>

        <div className="field span-2">
          <label>Inventory Preview</label>
          <div className="table-wrap" style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            <table className="data" style={{ width: '100%' }}>
              <tbody>
                {form.hasMultipleUnits ? (
                  <tr><td><strong>Conversion</strong></td><td>{conversionText || '—'}</td></tr>
                ) : null}
                <tr><td><strong>Cost per {form.unit || 'Base Unit'}</strong></td><td>{baseUnitCost > 0 ? `₱${baseUnitCost.toFixed(2)}` : '—'}</td></tr>
                <tr><td><strong>Retail Price per {form.unit || 'Base Unit'}</strong></td><td>{retailPrice > 0 ? `₱${retailPrice.toFixed(2)}` : '—'}</td></tr>
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
            <div className="field">
              <label>Purchase Unit</label>
              <select className="select" value={form.purchaseUnit} onChange={set('purchaseUnit')}>
                {purchaseUnitOptions.map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Units per Purchase Unit</label>
              <input className="input" type="number" min="1" value={form.conversionQuantity} onChange={(e) => setFormNumberValue('conversionQuantity', e.target.value)} />
              {conversionText ? <small style={{ display: 'block', marginTop: 6 }}>{conversionText}</small> : null}
            </div>

            <div className="field span-2">
              <label>Additional Selling Units</label>
              <div className="table-wrap" style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table className="data" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Barcode</th>
                      <th>Unit</th>
                      <th>Quantity</th>
                      <th>Selling Price</th>
                      <th style={{ width: 48 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellingUnits.map((row, index) => (
                      <tr key={`${row.barcode || 'unit'}-${index}`}>
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
