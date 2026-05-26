import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import ProductModal from '../components/ProductModal'
import { IconPlus, IconSearch, IconEdit, IconTrash, IconImage } from '../components/Icons'
import { api, defaultCategories, statusLabel, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

export default function ProductManagement() {
  const { data: list, setData: setList, loading, error } = useApi(api.products, [])
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState('All')
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState('')

  const categories = useMemo(() => {
    return [...new Set([...defaultCategories, ...list.map((p) => p.category).filter(Boolean)])]
  }, [list])

  const filtered = useMemo(() => {
    return list.filter((p) => {
      const q = query.trim().toLowerCase()
      const matchQ = !q || p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) ||
        (p.barcode || '').includes(q)
      const matchC = cat === 'All' || p.category === cat
      return matchQ && matchC
    })
  }, [list, query, cat])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  async function handleSave(data) {
    try {
      if (modal.mode === 'edit') {
        const updated = await api.updateProduct(modal.product.id, data)
        setList(list.map((p) => (p.id === modal.product.id ? updated : p)))
        flash('Product updated.')
      } else {
        const created = await api.createProduct(data)
        setList([created, ...list])
        flash('Product added.')
      }
      setModal(null)
    } catch (err) {
      flash(err.message || 'Unable to save product.')
    }
  }

  async function handleDelete(p) {
    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
      try {
        await api.deleteProduct(p.id)
        setList(list.filter((x) => x.id !== p.id))
        flash('Product deleted.')
      } catch (err) {
        flash(err.message || 'Unable to delete product.')
      }
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Product Management" subtitle="Loading product catalog..." />
        <div className="card"><div className="empty"><h4>Loading products</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Product Management" subtitle="Add, edit, and organize products in your catalog." />
        <div className="card"><div className="empty"><h4>Unable to load products</h4><p>{error}</p></div></div>
      </>
    )
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
              placeholder="Search by name, ID, or barcode..."
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
                        <div className="prod-thumb">
                          {p.imageUrl ? (
                            <img src={p.imageUrl} alt={p.name} />
                          ) : (
                            <IconImage size={18} />
                          )}
                        </div>
                        <div>
                          <div className="prod-name">{p.name}</div>
                          <div className="prod-id">{p.sku || p.id}</div>
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
          categories={categories}
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
