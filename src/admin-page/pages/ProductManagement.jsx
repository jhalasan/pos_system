import { Fragment, useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import ProductModal from '../components/ProductModal'
import Modal from '../components/Modal'
import { useAppDialog } from '../../components/AppDialogProvider'
import { IconPlus, IconSearch, IconEdit, IconTrash, IconArchive, IconImage, IconDownload, IconPrint } from '../components/Icons'
import { api, defaultCategories, statusLabel, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { printInventoryProducts } from '../utils/thermalInventoryPrinter'

function normalizeSellingUnits(product = {}) {
  const rawUnits = Array.isArray(product.sellingUnits)
    ? product.sellingUnits
    : (Array.isArray(product.selling_units) ? product.selling_units : [])
  const fallbackUnit = String(product.unit || 'Piece').trim() || 'Piece'
  const fallbackBarcode = String(product.barcode || '').trim()
  const fallbackPrice = Number(product.price) || 0

  const units = rawUnits.map((unit) => ({
    barcode: String(unit?.barcode || '').trim(),
    unit: String(unit?.unit || '').trim() || fallbackUnit,
    conversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
    price: Number(unit?.price) || fallbackPrice,
  }))

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

function getProductBarcodes(product) {
  return [...new Set(normalizeSellingUnits(product).map((unit) => unit.barcode).filter(Boolean))]
}

function getInventoryBreakdown(product) {
  const baseQty = Number(product.qty) || 0
  const units = normalizeSellingUnits(product)
    .filter((unit) => Number(unit.conversion) > 0)
    .sort((a, b) => Number(b.conversion) - Number(a.conversion))

  return units.map((unit) => ({
    ...unit,
    total: Math.floor(baseQty / Number(unit.conversion)),
  }))
}

function getInventoryRemainderBreakdown(product) {
  let remainingQty = Number(product.qty) || 0
  const units = normalizeSellingUnits(product)
    .filter((unit) => Number(unit.conversion) > 0)
    .sort((a, b) => Number(b.conversion) - Number(a.conversion))

  return units.map((unit, index) => {
    const conversion = Number(unit.conversion)
    const count = index === units.length - 1
      ? remainingQty
      : Math.floor(remainingQty / conversion)
    remainingQty -= count * conversion
    return {
      ...unit,
      count,
      total: Math.floor((Number(product.qty) || 0) / conversion),
    }
  })
}

function formatQty(value) {
  return Number(value || 0).toLocaleString('en-PH')
}

function pluralizeUnit(unit, quantity) {
  const cleanUnit = String(unit || 'unit').trim() || 'unit'
  if (Number(quantity) === 1) return cleanUnit
  if (/s$/i.test(cleanUnit)) return cleanUnit
  return `${cleanUnit}s`
}

function primaryInventoryLabel(product) {
  return {
    main: formatQty(product.qty),
    detail: '',
  }
}

function breakdownUnitLabel(product, unit) {
  if (Number(unit.conversion) > 1) return `${unit.unit} (F)`
  return `${pluralizeUnit(product.unit, unit.count)} (L)`
}

function formatProductPrice(product) {
  const units = normalizeSellingUnits(product)
    .map((unit) => ({
      unit: String(unit.unit || '').trim(),
      conversion: Number(unit.conversion) || 1,
      price: Number(unit.price) || 0,
    }))
    .filter((unit) => unit.unit)
    .sort((a, b) => a.conversion - b.conversion)
    .reduce((acc, unit) => {
      if (acc.some((item) => item.unit === unit.unit)) return acc
      return [...acc, unit]
    }, [])

  if (units.length === 0) {
    return peso(product.price)
  }

  const baseUnit = units.find((unit) => unit.conversion === 1) || units[0]
  return peso(baseUnit.price)
}

export default function ProductManagement() {
  const dialog = useAppDialog()
  const pageSize = 20
  const { data: list, setData: setList, loading, error } = useApi(api.products, [])
  const { data: categoryRecords, setData: setCategoryRecords } = useApi(api.categories, [])
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState('All')
  const [stockFilter, setStockFilter] = useState('all')
  const [lifecycleFilter, setLifecycleFilter] = useState('active')
  const [sortBy, setSortBy] = useState('name-asc')
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [selectedProducts, setSelectedProducts] = useState(() => new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [modal, setModal] = useState(null)
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [categorySaving, setCategorySaving] = useState(false)
  const [toast, setToast] = useState('')
  const [exporting, setExporting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [expandedProducts, setExpandedProducts] = useState(() => new Set())

  useEffect(() => {
    const handleSyncStatus = (event) => {
      if (event.detail?.state !== 'succeeded') return
      void api.products().then(setList).catch(() => {})
    }
    globalThis.addEventListener?.('nexa-sync-status', handleSyncStatus)
    return () => globalThis.removeEventListener?.('nexa-sync-status', handleSyncStatus)
  }, [setList])

  const categories = useMemo(() => {
    return [...new Set([
      ...defaultCategories,
      ...categoryRecords.map((category) => category.name).filter(Boolean),
      ...list.map((p) => p.category).filter(Boolean),
    ])]
  }, [categoryRecords, list])

  const filtered = useMemo(() => {
    const matches = list.filter((p) => {
      const q = query.trim().toLowerCase()
      const barcodes = getProductBarcodes(p)
      const matchQ = !q || p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) ||
        barcodes.some((barcode) => barcode.toLowerCase().includes(q)) ||
        normalizeSellingUnits(p).some((unit) => String(unit.unit || '').toLowerCase().includes(q))
      const matchC = cat === 'All' || p.category === cat
      const quantity = Number(p.qty) || 0
      const status = quantity <= 0 ? 'out-of-stock' : (p.status || 'in-stock')
      const matchStock = stockFilter === 'all' || status === stockFilter
      const lifecycle = p.lifecycleStatus || 'active'
      const matchLifecycle = lifecycleFilter === 'all' || lifecycle === lifecycleFilter
      return matchQ && matchC && matchStock && matchLifecycle
    })
    return matches.sort((a, b) => {
      if (sortBy === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''), undefined, { sensitivity: 'base' })
      if (sortBy === 'stock-asc') return (Number(a.qty) || 0) - (Number(b.qty) || 0)
      if (sortBy === 'stock-desc') return (Number(b.qty) || 0) - (Number(a.qty) || 0)
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    })
  }, [list, query, cat, stockFilter, lifecycleFilter, sortBy])

  const visibleProducts = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const integrity = useMemo(() => {
    const barcodeOwners = new Map()
    for (const product of list) {
      for (const barcode of getProductBarcodes(product)) barcodeOwners.set(barcode, (barcodeOwners.get(barcode) || 0) + 1)
    }
    return [
      { label: 'Missing/generated barcodes', value: list.filter((p) => !p.barcode || String(p.barcode).startsWith('LEGACY-')).length, filter: '' },
      { label: 'Uncategorized', value: list.filter((p) => !p.category || /uncategorized/i.test(p.category)).length, filter: 'Uncategorized (Legacy)' },
      { label: 'Non-positive prices', value: list.filter((p) => Number(p.price) <= 0).length, filter: '' },
      { label: 'Negative inventory', value: list.filter((p) => Number(p.qty) < 0).length, filter: '' },
      { label: 'Duplicate barcodes', value: [...barcodeOwners.values()].filter((count) => count > 1).length, filter: '' },
    ]
  }, [list])

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
    if (await dialog.confirm(`Delete “${p.name}”?\n\nThis action cannot be undone.`, { title: 'Delete product', confirmLabel: 'Delete product' })) {
      try {
        await api.deleteProduct(p.id)
        setList(list.filter((x) => x.id !== p.id))
        flash('Product deleted.')
      } catch (err) {
        flash(err.message || 'Unable to delete product.')
      }
    }
  }

  async function handleLifecycle(p, lifecycleStatus) {
    try {
      const updated = await api.updateProduct(p.id, { ...p, lifecycleStatus })
      setList(list.map((item) => (item.id === p.id ? updated : item)))
      flash(`${p.name} marked ${lifecycleStatus}.`)
    } catch (err) {
      flash(err.message || 'Unable to update product lifecycle.')
    }
  }

  function toggleSelected(id) {
    setSelectedProducts((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function applyBulkUpdate(kind) {
    const targets = list.filter((product) => selectedProducts.has(product.id))
    if (!targets.length) return flash('Select at least one product.')
    setBulkSaving(true)
    try {
      const updates = []
      for (const product of targets) {
        const patch = kind === 'category' ? { category: bulkCategory } : { lifecycleStatus: kind }
        updates.push(await api.updateProduct(product.id, { ...product, ...patch }))
      }
      const byId = new Map(updates.map((product) => [product.id, product]))
      setList(list.map((product) => byId.get(product.id) || product))
      setSelectedProducts(new Set())
      flash(`Updated ${updates.length} product(s).`)
    } catch (err) { flash(err.message || 'Bulk update failed.') }
    finally { setBulkSaving(false) }
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

  function toggleProductBreakdown(productId) {
    setExpandedProducts((current) => {
      const next = new Set(current)
      if (next.has(productId)) {
        next.delete(productId)
      } else {
        next.add(productId)
      }
      return next
    })
  }

  async function exportProducts() {
    setExporting(true)
    setExportStatus('Exporting...')
    try {
      const result = await exportCsv(`products-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Name', 'Barcodes', 'Category', 'Quantity', 'Unit', 'Price', 'Status', 'Unit Breakdown'],
        ...filtered.map((product) => [
          product.name,
          getProductBarcodes(product).join(' | '),
          product.category,
          product.qty,
          product.unit,
          product.price,
          product.status,
          getInventoryBreakdown(product)
            .map((unit) => `${unit.total} ${unit.unit} available (${unit.conversion} ${product.unit}; ${peso(unit.price)})`)
            .join(' | '),
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
    return <PageLoader title="Product Management" message="Loading product catalog…" />
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

      <div className="integrity-strip" aria-label="Product data integrity summary">
        {integrity.map((item) => (
          <button
            type="button"
            className={`integrity-item ${item.value ? 'has-issues' : 'clean'}`}
            key={item.label}
            onClick={() => { if (item.filter) setCat(item.filter); setVisibleCount(pageSize) }}
          >
            <strong>{item.value.toLocaleString()}</strong>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {selectedProducts.size > 0 && (
          <div className="bulk-product-bar">
            <strong>{selectedProducts.size} selected</strong>
            <select className="select" value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}><option value="">Choose category…</option>{categories.map((category) => <option key={category}>{category}</option>)}</select>
            <button className="btn btn-outline" disabled={!bulkCategory || bulkSaving} onClick={() => applyBulkUpdate('category')}>Assign Category</button>
            <button className="btn btn-outline" disabled={bulkSaving} onClick={() => applyBulkUpdate('inactive')}>Mark Inactive</button>
            <button className="btn btn-outline" disabled={bulkSaving} onClick={() => applyBulkUpdate('archived')}>Archive</button>
            <button className="btn btn-outline" disabled={bulkSaving} onClick={() => applyBulkUpdate('active')}>Activate</button>
          </div>
        )}
        <div className="toolbar">
          <div className="input-search">
            <IconSearch size={16} />
            <input
              className="input"
              placeholder="Search by name, ID, or barcode..."
              value={query}
              onChange={(e) => { setQuery(e.target.value); setVisibleCount(pageSize) }}
            />
          </div>
          <select className="select" value={cat} onChange={(e) => { setCat(e.target.value); setVisibleCount(pageSize) }}>
            <option value="All">All Categories</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select className="select" value={stockFilter} onChange={(e) => { setStockFilter(e.target.value); setVisibleCount(pageSize) }} aria-label="Filter by stock status">
            <option value="all">All Stock Statuses</option>
            <option value="in-stock">In Stock</option>
            <option value="low">Low Stock</option>
            <option value="critical">Restock Needed</option>
            <option value="out-of-stock">Out of Stock</option>
          </select>
          <select className="select" value={lifecycleFilter} onChange={(e) => { setLifecycleFilter(e.target.value); setVisibleCount(pageSize) }} aria-label="Filter by lifecycle status">
            <option value="active">Active Products</option>
            <option value="inactive">Inactive Products</option>
            <option value="archived">Archived Products</option>
            <option value="all">All Lifecycle Statuses</option>
          </select>
          <select className="select" value={sortBy} onChange={(e) => { setSortBy(e.target.value); setVisibleCount(pageSize) }} aria-label="Sort products">
            <option value="name-asc">Name: A–Z</option>
            <option value="name-desc">Name: Z–A</option>
            <option value="stock-asc">Stock: Low to High</option>
            <option value="stock-desc">Stock: High to Low</option>
          </select>
          <span className="count">
            Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} matching products
          </span>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th aria-label="Select products"><input type="checkbox" checked={visibleProducts.length > 0 && visibleProducts.every((p) => selectedProducts.has(p.id))} onChange={(event) => setSelectedProducts((current) => { const next = new Set(current); for (const p of visibleProducts) { if (event.target.checked) next.add(p.id); else next.delete(p.id) } return next })} /></th>
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
                  <td colSpan={9}>
                    <div className="empty">
                      <div className="em-icon"><IconSearch size={24} /></div>
                      <h4>No products found</h4>
                      <p>Try adjusting your search or category filter.</p>
                    </div>
                  </td>
                </tr>
              )}
              {visibleProducts.map((p) => {
                const isOutOfStock = Number(p.qty) <= 0
                const st = isOutOfStock
                  ? statusLabel['out-of-stock']
                  : statusLabel[p.status] || statusLabel['in-stock']
                const barcodes = getProductBarcodes(p)
                const breakdown = getInventoryBreakdown(p)
                const remainderBreakdown = getInventoryRemainderBreakdown(p)
                const hasMultipleUnits = Boolean((p.hasMultipleUnits ?? p.has_multiple_units) || breakdown.length > 1)
                const inventoryLabel = primaryInventoryLabel(p)
                const isExpanded = expandedProducts.has(p.id)
                const stockToneClass = isOutOfStock || p.status === 'critical'
                  ? 'product-row-critical'
                  : p.status === 'low' ? 'product-row-low' : ''
                return (
                  <Fragment key={p.id}>
                    <tr className={`product-group-row ${stockToneClass} ${isOutOfStock ? 'product-row-out' : ''}`}>
                      <td><input type="checkbox" checked={selectedProducts.has(p.id)} onChange={() => toggleSelected(p.id)} aria-label={`Select ${p.name}`} /></td>
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
                            <div className="prod-id">{p.sku || p.id} {hasMultipleUnits ? '| Product group' : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">
                        <div className="barcode-stack">
                          <span>{barcodes[0] || 'No barcode'}</span>
                          {barcodes.length > 1 ? <small>{barcodes.length} barcodes</small> : null}
                        </div>
                      </td>
                      <td>{p.category}</td>
                      <td className={`t-center ${isOutOfStock ? 'stock-zero' : ''}`}>
                        <div className="stock-stack">
                          <strong>{inventoryLabel.main}</strong>
                          {inventoryLabel.detail ? <small>{inventoryLabel.detail}</small> : null}
                          {hasMultipleUnits ? (
                            <button
                              type="button"
                              className="link-btn stock-see-more"
                              onClick={() => toggleProductBreakdown(p.id)}
                              aria-expanded={isExpanded}
                            >
                              {isExpanded ? 'Hide breakdown' : 'See more'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td>{p.unit}</td>
                      <td>{formatProductPrice(p)}</td>
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
                            className="icon-btn"
                            title={(p.lifecycleStatus || 'active') === 'archived' ? 'Restore product' : 'Archive product'}
                            onClick={() => handleLifecycle(p, (p.lifecycleStatus || 'active') === 'archived' ? 'active' : 'archived')}
                          >
                            {(p.lifecycleStatus || 'active') === 'archived' ? '↺' : <IconArchive size={15} />}
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
                    {isExpanded ? remainderBreakdown.map((unit, index) => (
                      <tr className="product-unit-row product-breakdown-row" key={`${p.id}-${unit.barcode || unit.unit}-${unit.conversion}`}>
                        <td />
                        <td>
                          <div className="breakdown-row-label">
                            <span className="unit-branch">↳</span>
                            <span>{index === 0 ? 'Unit breakdown' : ''}</span>
                          </div>
                        </td>
                        <td className="mono">{unit.barcode || '—'}</td>
                        <td aria-label="Same category as product" />
                        <td className="t-center"><strong>{formatQty(unit.count)}</strong></td>
                        <td><strong>{breakdownUnitLabel(p, unit)}</strong></td>
                        <td>{peso(Number(unit.price) || 0)}</td>
                        <td />
                        <td />
                      </tr>
                    )) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {visibleCount < filtered.length && (
          <div className="product-see-more-wrap">
            <button className="btn btn-outline" type="button" onClick={() => setVisibleCount((count) => count + pageSize)}>
              See more products ({filtered.length - visibleCount} remaining)
            </button>
          </div>
        )}
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
