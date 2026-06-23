import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import ProductModal from '../components/ProductModal'
import Modal from '../components/Modal'
import { IconPlus, IconSearch, IconEdit, IconTrash, IconImage, IconDownload, IconPrint } from '../components/Icons'
import { api, defaultCategories, statusLabel, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { printInventoryProducts } from '../utils/thermalInventoryPrinter'

export default function ProductManagement() {
  const { data: list, setData: setList, loading, error } = useApi(api.products, [])
  const { data: categoryRecords, setData: setCategoryRecords } = useApi(api.categories, [])
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState('All')
  const [modal, setModal] = useState(null)
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [categorySaving, setCategorySaving] = useState(false)
  const [toast, setToast] = useState('')
  const [exporting, setExporting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')

  const categories = useMemo(() => {
    return [...new Set([
      ...defaultCategories,
      ...categoryRecords.map((category) => category.name).filter(Boolean),
      ...list.map((p) => p.category).filter(Boolean),
    ])]
  }, [categoryRecords, list])

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

  async function handleCreateCategory() {
    const name = categoryName.trim()
    if (!name) {
      setCategoryError('Category name is required.')
      return
    }

    setCategorySaving(true)
    setCategoryError('')
    try {
      const created = await api.createCategory(name)
      setCategoryRecords([
        created,
        ...categoryRecords.filter((category) => category.name.toLowerCase() !== created.name.toLowerCase()),
      ])
      setCategoryName('')
      setCategoryModalOpen(false)
      flash(`Created category "${created.name}".`)
    } catch (err) {
      setCategoryError(err.message || 'Unable to create category.')
    } finally {
      setCategorySaving(false)
    }
  }

  async function exportProducts() {
    setExporting(true)
    setExportStatus('Exporting...')
    try {
      const result = await exportCsv(`products-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Name', 'Barcode', 'Category', 'Quantity', 'Unit', 'Price', 'Status'],
        ...filtered.map((product) => [
          product.name,
          product.barcode,
          product.category,
          product.qty,
          product.unit,
          product.price,
          product.status,
        ]),
      ], { directory: getExportLocation(exportLocationKeys.products) })
      setExportStatus(`Exported in - "${result.path}"`)
    } catch (err) {
      setExportStatus(err.message || 'Unable to export products.')
    } finally {
      setExporting(false)
    }
  }

  async function printProducts() {
    setPrinting(true)
    try {
      await printInventoryProducts(filtered, {
        title: cat === 'All' ? 'Inventory Report' : `${cat} Inventory`,
      })
      flash(`Printed ${filtered.length} product(s).`)
    } catch (err) {
      flash((typeof err === 'string' ? err : err.message) || 'Unable to print products.')
    } finally {
      setPrinting(false)
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
        <button className="btn btn-outline" onClick={printProducts} disabled={printing || filtered.length === 0}>
          <IconPrint size={16} /> {printing ? 'Printing...' : 'Print Inventory'}
        </button>
        <button className="btn btn-outline" onClick={exportProducts} disabled={exporting}>
          <IconDownload size={16} /> {exporting ? 'Exporting...' : 'Export Products'}
        </button>
        <button className="btn btn-outline" onClick={() => setCategoryModalOpen(true)}>
          <IconPlus size={16} /> Create Category
        </button>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'add' })}>
          <IconPlus size={16} /> Add Product
        </button>
      </PageHeader>
      {exportStatus && <div className="export-status">{exportStatus}</div>}

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
                const isOutOfStock = Number(p.qty) <= 0
                const st = isOutOfStock
                  ? statusLabel['out-of-stock']
                  : statusLabel[p.status] || statusLabel['in-stock']
                return (
                  <tr key={p.id} className={isOutOfStock ? 'product-row-out' : ''}>
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
                    <td className={`t-center ${isOutOfStock ? 'stock-zero' : ''}`}>{p.qty}</td>
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

      {categoryModalOpen && (
        <Modal
          title="Create Category"
          onClose={() => {
            setCategoryModalOpen(false)
            setCategoryName('')
            setCategoryError('')
          }}
          footer={(
            <>
              <button
                className="btn btn-outline"
                disabled={categorySaving}
                onClick={() => {
                  setCategoryModalOpen(false)
                  setCategoryName('')
                  setCategoryError('')
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={categorySaving} onClick={handleCreateCategory}>
                {categorySaving ? 'Creating...' : 'Create Category'}
              </button>
            </>
          )}
        >
          <div className="field">
            <label>Category Name</label>
            <input
              className="input"
              placeholder="e.g. Frozen Goods"
              value={categoryName}
              onChange={(event) => {
                setCategoryName(event.target.value)
                setCategoryError('')
              }}
              onKeyDown={(event) => { if (event.key === 'Enter') handleCreateCategory() }}
              autoFocus
            />
          </div>
          {categoryError && <div className="alert error">{categoryError}</div>}
        </Modal>
      )}

      {toast && (
        <div className="toast"><IconPlus size={15} /> {toast}</div>
      )}
    </>
  )
}
