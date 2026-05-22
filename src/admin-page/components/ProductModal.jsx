import { useState } from 'react'
import Modal from './Modal'
import { IconImage, IconPlus, IconTrash } from './Icons'
import { categories } from '../data/mockData'

const blank = {
  name: '', barcode: '', category: categories[0], unit: 'Piece',
  qty: 0, lowStock: 10, price: 0,
}

export default function ProductModal({ mode, product, onClose, onSave }) {
  const [form, setForm] = useState(product ? { ...product } : { ...blank })
  const [tiers, setTiers] = useState(
    product?.tiers || [{ label: 'Retail', price: product?.price || 0 }]
  )

  const isEdit = mode === 'edit'
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  function setTier(i, key, val) {
    setTiers(tiers.map((t, idx) => (idx === i ? { ...t, [key]: val } : t)))
  }
  function addTier() {
    setTiers([...tiers, { label: '', price: 0 }])
  }
  function removeTier(i) {
    setTiers(tiers.filter((_, idx) => idx !== i))
  }

  function submit() {
    if (!form.name.trim()) { alert('Product name is required.'); return }
    onSave({
      ...form,
      qty: Number(form.qty) || 0,
      lowStock: Number(form.lowStock) || 0,
      price: Number(tiers[0]?.price) || 0,
      tiers,
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
          <div className="img-drop">
            <div className="di"><IconImage size={20} /></div>
            Drag an image here, or click to upload
          </div>
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
                placeholder="Price"
                value={t.price}
                onChange={(e) => setTier(i, 'price', e.target.value)}
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
