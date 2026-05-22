import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import ProductModal from '../components/ProductModal'
import { IconPlus, IconSearch, IconEdit, IconTrash, IconImage } from '../components/Icons'
import { products as seed, categories, statusLabel, peso } from '../data/mockData'

function deriveStatus(p) {
  if (p.qty <= 5) return 'critical'
  if (p.qty <= (p.lowStock ?? 10)) return 'low'
  return 'in-stock'
}

export default function ProductManagement() {
  const [list, setList] = useState(seed)
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState('All')
  const [modal, setModal] = useState(null) // { mode, product }
  const [toast, setToast] = useState('')

  const filtered = useMemo(() => {
    return list.filter((p) => {
      const q = query.trim().toLowerCase()
      const matchQ = !q || p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) || p.barcode.includes(q)
      const matchC = cat === 'All' || p.category === cat
      return matchQ && matchC
    })
  }, [list, query, cat])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  function handleSave(data) {
    if (modal.mode === 'edit') {
      setList(list.map((p) => (p.id === modal.product.id ? { ...p, ...data, status: deriveStatus(data) } : p)))
      flash('Product updated.')
    } else {
      const id = 'PRD-' + (1000 + list.length + 1)
      setList([{ ...data, id, status: deriveStatus(data) }, ...list])
      flash('Product added.')
    }
    setModal(null)
  }

  function handleDelete(p) {
    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
      setList(list.filter((x) => x.id !== p.id))
      flash('Product deleted.')
    }
  }

  return (
    <>
      <PageHeader
        title="Product Management"
        subtitle="Add, edit, and organize products in your catalog."
      >
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'add' })}>
          <IconPlus size={16} /> Add Product
        </button>
      </PageHeader>

      <div className="card">
        <div className="toolbar">
          <div className="input-search">
            <IconSearch size={16} />
            <input
              className="input"
              placeholder="Search by name, ID, or barcode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select className="select" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="All">All Categories</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="count">
            Showing {filtered.length} of {list.length} products
          </span>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Barcode</th>
                <th>Category</th>
                <th className="t-center">Quantity</th>
                <th>Base Unit</th>
                <th>Price</th>
                <th>Status</th>
                <th className="t-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">
                      <div className="em-icon"><IconSearch size={24} /></div>
                      <h4>No products found</h4>
                      <p>Try adjusting your search or category filter.</p>
                    </div>
                  </td>
                </tr>
              )}
              {filtered.map((p) => {
                const st = statusLabel[p.status] || statusLabel['in-stock']
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="prod-cell">
                        <div className="prod-thumb"><IconImage size={18} /></div>
                        <div>
                          <div className="prod-name">{p.name}</div>
                          <div className="prod-id">{p.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{p.barcode}</td>
                    <td>{p.category}</td>
                    <td className="t-center">{p.qty}</td>
                    <td>{p.unit}</td>
                    <td>{peso(p.price)}</td>
                    <td><span className={`badge ${st.badge}`}>{st.text}</span></td>
                    <td className="t-center">
                      <div className="row-actions row-actions-center">
                        <button
                          className="icon-btn"
                          title="Edit"
                          onClick={() => setModal({ mode: 'edit', product: p })}
                        >
                          <IconEdit size={15} />
                        </button>
                        <button
                          className="icon-btn del"
                          title="Delete"
                          onClick={() => handleDelete(p)}
                        >
                          <IconTrash size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <ProductModal
          mode={modal.mode}
          product={modal.product}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}

      {toast && (
        <div className="toast"><IconPlus size={15} /> {toast}</div>
      )}
    </>
  )
}
