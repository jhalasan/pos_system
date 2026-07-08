import { Fragment, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import ProductModal from '../components/ProductModal'
import Modal from '../components/Modal'
import { IconPlus, IconSearch, IconEdit, IconTrash, IconImage, IconDownload, IconPrint } from '../components/Icons'
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
  const hasMultipleUnits = Boolean((product.hasMultipleUnits ?? product.has_multiple_units) || getInventoryBreakdown(product).length > 1)
  if (!hasMultipleUnits) {
    return {
      main: formatQty(product.qty),
      detail: '',
    }
  }

  const breakdown = getInventoryRemainderBreakdown(product)
  const visibleBreakdown = breakdown.filter((unit) => Number(unit.count) > 0)
  if (breakdown.length === 0) {
    return {
      main: formatQty(product.qty),
      detail: `${formatQty(product.qty)} ${pluralizeUnit(product.unit, product.qty)} total`,
    }
  }

  const summary = (visibleBreakdown.length ? visibleBreakdown : [breakdown[breakdown.length - 1]])
    .map((unit) => `${formatQty(unit.count)} ${pluralizeUnit(unit.unit, unit.count)}`)
    .join(', ')

  return {
    main: summary,
    detail: `${formatQty(product.qty)} ${pluralizeUnit(product.unit, product.qty)} total`,
  }
}

function unitRowLabel(product, unit) {
  const conversion = Number(unit.conversion) || 1
  if (conversion === 1) return `1 ${unit.unit} = 1 ${product.unit}`
  return `1 ${unit.unit} = ${formatQty(conversion)} ${pluralizeUnit(product.unit, conversion)}`
}

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
  const [expandedProducts, setExpandedProducts] = useState(() => new Set())

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
      const barcodes = getProductBarcodes(p)
      const matchQ = !q || p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) ||
        barcodes.some((barcode) => barcode.toLowerCase().includes(q)) ||
        normalizeSellingUnits(p).some((unit) => String(unit.unit || '').toLowerCase().includes(q))
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
                const barcodes = getProductBarcodes(p)
                const breakdown = getInventoryBreakdown(p)
                const remainderBreakdown = getInventoryRemainderBreakdown(p)
                const hasMultipleUnits = Boolean((p.hasMultipleUnits ?? p.has_multiple_units) || breakdown.length > 1)
                const inventoryLabel = primaryInventoryLabel(p)
                const isExpanded = expandedProducts.has(p.id)
                return (
                  <Fragment key={p.id}>
                    <tr className={`product-group-row ${isOutOfStock ? 'product-row-out' : ''}`}>
                      <td>
                        <div className="prod-cell">
                          {hasMultipleUnits ? (
                            <button
                              type="button"
                              className="group-toggle"
                              title={isExpanded ? 'Hide unit rows' : 'Show unit rows'}
                              onClick={() => toggleProductBreakdown(p.id)}
                              aria-expanded={isExpanded}
                            >
                              {isExpanded ? '▾' : '▸'}
                            </button>
                          ) : null}
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
                      <td>{hasMultipleUnits ? 'Grouped' : peso(p.price)}</td>
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
                    {isExpanded ? remainderBreakdown.map((unit) => (
                      <tr className="product-unit-row" key={`${p.id}-${unit.barcode || unit.unit}-${unit.conversion}`}>
                        <td>
                          <div className="prod-cell product-unit-cell">
                            <span className="unit-branch">↳</span>
                            <div>
                              <div className="prod-name">{p.name} - {unit.unit}</div>
                              <div className="prod-id">{unitRowLabel(p, unit)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="mono">{unit.barcode || 'No barcode'}</td>
                        <td>{p.category}</td>
                        <td className="t-center">
                          <div className="stock-stack">
                            <strong>{formatQty(unit.total)} {pluralizeUnit(unit.unit, unit.total)} available</strong>
                            <small>{formatQty(unit.count)} {pluralizeUnit(unit.unit, unit.count)} in breakdown</small>
                          </div>
                        </td>
                        <td>{unit.unit}</td>
                        <td>{peso(unit.price)}</td>
                        <td><span className="badge badge-neutral">Sub Unit</span></td>
                        <td className="t-center">
                          <button
                            className="icon-btn"
                            title="Edit product units"
                            onClick={() => setModal({ mode: 'edit', product: p })}
                          >
                            <IconEdit size={15} />
                          </button>
                        </td>
                      </tr>
                    )) : null}
                  </Fragment>
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
