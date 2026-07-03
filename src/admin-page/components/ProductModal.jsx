import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { IconImage, IconPlus, IconTrash } from './Icons'
import { defaultCategories } from '../services/api'

const blank = {
  name: '', barcode: '', category: defaultCategories[0], unit: 'Piece',
  qty: 0, lowStock: 10, price: 0, cost: 0, profitMargin: 0,
}

export default function ProductModal({ mode, product, categories = defaultCategories, onClose, onSave }) {
  const initialForm = product
    ? { ...product, cost: Number(product.cost) || Number(product.price) || 0, profitMargin: Number(product.profitMargin) || 0 }
    : { ...blank, category: categories[0] || '' }
  const [form, setForm] = useState(initialForm)
  const [tiers, setTiers] = useState(
    product?.tiers || [{ label: 'Retail', price: product?.price || 0 }]
  )
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

  function setTier(i, key, val) {
    setTiers(tiers.map((t, idx) => (idx === i ? { ...t, [key]: val } : t)))
  }
  function addTier() {
    setTiers([...tiers, { label: '', price: '0.00' }])
  }
  function removeTier(i) {
    setTiers(tiers.filter((_, idx) => idx !== i))
  }

  function formatPriceInput(value) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00'
  }

  function deriveRetailPrice(cost, profitMargin) {
    const costValue = Number(cost)
    const marginPercent = Number(profitMargin)
    if (!Number.isFinite(costValue) || costValue <= 0) return 0
    const margin = Number.isFinite(marginPercent) ? marginPercent / 100 : 0
    if (margin < 0 || margin >= 1) return 0
    return Number((costValue / (1 - margin)).toFixed(2))
  }

  function setFormValue(key, value) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'cost' || key === 'profitMargin') {
        const nextPrice = deriveRetailPrice(next.cost, next.profitMargin)
        setTiers((current) => {
          if (!nextPrice) return current
          if (current.length === 0) return [{ label: 'Retail', price: nextPrice }]
          return current.map((tier, idx) => idx === 0 ? { ...tier, price: nextPrice } : tier)
        })
      }
      return next
    })
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

  function submit() {
    const costValue = Number(form.cost)
    const marginValue = Number(form.profitMargin)
    let retailPrice = Number(form.price)

    if (costValue > 0 && Number.isFinite(marginValue) && marginValue >= 0 && marginValue < 100) {
      retailPrice = deriveRetailPrice(costValue, marginValue)
    } else if (!isEdit) {
      alert('Enter a valid cost and profit margin to calculate retail price.')
      return
    }

    if (!form.name.trim()) { alert('Product name is required.'); return }
    if (costValue < 0) { alert('Cost of goods sold must be 0 or greater.'); return }
    if (costValue > 0 && (!Number.isFinite(marginValue) || marginValue < 0 || marginValue >= 100)) {
      alert('Desired profit margin must be between 0 and 99.99%.')
      return
    }
    if (retailPrice <= 0) { alert('Retail price could not be calculated from cost and profit margin.'); return }

    onSave({
      ...form,
      qty: Number(form.qty) || 0,
      lowStock: Number(form.lowStock) || 0,
      cost: costValue,
      profitMargin: marginValue,
      price: retailPrice,
      tiers,
      imageFile,
    })
  }

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
          <label>Barcode</label>
          <input className="input" placeholder="Scan or enter barcode" value={form.barcode} onChange={set('barcode')} />
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
            {['Piece', 'Pack', 'Sachet', 'Bottle', 'Box', 'Sack'].map((u) => <option key={u}>{u}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Initial Quantity</label>
          <input className="input" type="number" min="0" value={form.qty} onChange={set('qty')} />
        </div>
        <div className="field">
          <label>Low Stock Alert</label>
          <input className="input" type="number" min="0" value={form.lowStock} onChange={set('lowStock')} />
        </div>

        <div className="field">
          <label>Cost of Goods Sold</label>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={form.cost}
            onChange={set('cost')}
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
            onChange={set('profitMargin')}
            onBlur={(e) => setFormValue('profitMargin', formatPriceInput(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Retail Price</label>
          <input className="input" type="number" readOnly value={deriveRetailPrice(form.cost, form.profitMargin) || Number(form.price) || 0} />
          <small>Retail = Cost / (1 - Margin)</small>
        </div>

        <div className="field span-2">
          <label>Pricing Tiers</label>
          {tiers.map((t, i) => (
            <div className="tier-row" key={i}>
              <input
                className="input"
                placeholder="Tier name (e.g. Retail, Wholesale)"
                value={t.label}
                onChange={(e) => setTier(i, 'label', e.target.value)}
              />
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                placeholder="Price"
                value={t.price}
                onChange={(e) => setTier(i, 'price', e.target.value)}
                onBlur={(e) => setTier(i, 'price', formatPriceInput(e.target.value))}
              />
              <button
                className="icon-btn del"
                onClick={() => removeTier(i)}
                disabled={tiers.length === 1}
                title="Remove tier"
              >
                <IconTrash size={15} />
              </button>
            </div>
          ))}
          <button className="btn btn-outline btn-sm" onClick={addTier} style={{ marginTop: 4 }}>
            <IconPlus size={14} /> Add Tier
          </button>
        </div>
      </div>
    </Modal>
  )
}
