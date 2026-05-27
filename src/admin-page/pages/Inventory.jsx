import { useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import ProductModal from '../components/ProductModal'
import { IconBox, IconAlert, IconDollar, IconScan, IconCheck, IconTag, IconChart } from '../components/Icons'
import { api, defaultCategories, peso, statusLabel } from '../services/api'
import { useApi } from '../hooks/useApi'

export default function Inventory() {
  const { data: products, setData: setProducts, loading, error } = useApi(api.products, [])
  const { data: fsnProducts, setData: setFsnProducts } = useApi(api.fsnInventory, [])
  const barcodeRef = useRef(null)
  const [barcode, setBarcode] = useState('')
  const [qty, setQty] = useState(1)
  const [feed, setFeed] = useState([])
  const [scanError, setScanError] = useState('')
  const [selectedFsn, setSelectedFsn] = useState('Fast-moving')
  const [newProductBarcode, setNewProductBarcode] = useState('')
  const [toast, setToast] = useState('')

  const totalProducts = products.length
  const lowItems = products.filter((p) => p.status !== 'in-stock').length
  const stockValue = products.reduce((s, p) => s + p.qty * p.price, 0)
  const categories = useMemo(() => {
    return [...new Set([...defaultCategories, ...products.map((p) => p.category).filter(Boolean)])]
  }, [products])
  const scannedUnits = feed.reduce((s, f) => s + f.qty, 0)
  const scannedProduct = useMemo(() => {
    const code = barcode.trim()
    if (!code) return null
    return products.find((p) => String(p.barcode || '') === code) || null
  }, [barcode, products])
  const barcodeMatches = useMemo(() => {
    const query = barcode.trim().toLowerCase()
    if (!query || scannedProduct) return []
    return products
      .filter((p) => (
        String(p.barcode || '').toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query)
      ))
      .slice(0, 6)
  }, [barcode, products, scannedProduct])
  const hasUnknownBarcode = barcode.trim() && !scannedProduct

  const movementProducts = fsnProducts.length
    ? fsnProducts
    : products.map((product) => ({
        ...product,
        fsn: 'Non-moving',
        fsnReason: 'No sales data loaded yet',
        units90: 0,
        averageMonthlyUnits: 0,
      }))
  const fastProducts = movementProducts.filter((p) => p.fsn === 'Fast-moving')
  const slowProducts = movementProducts.filter((p) => p.fsn === 'Slow-moving')
  const nonMovingProducts = movementProducts.filter((p) => p.fsn === 'Non-moving')

  function focusBarcode() {
    window.requestAnimationFrame(() => barcodeRef.current?.focus())
  }

  function flash(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function scan(e) {
    e.preventDefault()
    const code = barcode.trim()
    if (!code) return
    const stockInQty = Math.max(1, Math.floor(Number(qty) || 1))

    try {
      const updated = await api.scanInventory({ barcode: code, qty: stockInQty })
      setProducts(products.map((p) => (p.id === updated.id ? updated : p)))
      setFsnProducts(fsnProducts.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))
      setFeed((f) => [
        {
          key: `${Date.now()}-${updated.id}`,
          name: updated.name,
          id: updated.sku || updated.id,
          barcode: updated.barcode,
          qty: stockInQty,
          newQty: updated.qty,
          time: new Date(),
        },
        ...f.slice(0, 14),
      ])
      setBarcode('')
      setScanError('')
      flash(`Added ${stockInQty} unit(s) to ${updated.name}.`)
      focusBarcode()
    } catch (err) {
      setScanError(err.message || `No product found for barcode "${code}".`)
      focusBarcode()
    }
  }

  async function handleCreateProduct(data) {
    try {
      const created = await api.createProduct(data)
      setProducts([created, ...products])
      setFsnProducts([{
        ...created,
        fsn: 'Non-moving',
        fsnReason: 'No recorded sales yet',
        units90: 0,
        averageMonthlyUnits: 0,
        lastSoldAt: null,
        daysSinceLastSale: null,
      }, ...fsnProducts])
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
          <span className="sub">{scannedUnits} unit(s) added this session</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="scan-flow">
          <IconScan size={16} />
          <span>Workflow: set <b>Qty per scan</b>, scan a barcode, then scanner Enter adds stock and refocuses the barcode field.</span>
        </div>

        <form className="scan-grid" onSubmit={scan}>
          <div className="field scan-search-field">
            <label><span className="scan-step-no">1</span>Scan Barcode</label>
            <input
              ref={barcodeRef}
              className="input"
              placeholder="Scan barcode or search product"
              value={barcode}
              onChange={(e) => { setBarcode(e.target.value); setScanError('') }}
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
          <button type="submit" className="btn btn-primary" style={{ height: 38 }}>
            <span className="scan-step-no" style={{ background: 'rgba(255,255,255,.3)' }}>3</span>
            Add to Stock
          </button>
        </form>

        {barcode.trim() && (
          <div className={`scan-preview ${scannedProduct ? 'found' : 'missing'}`}>
            {scannedProduct ? (
              <>
                <div>
                  <strong>{scannedProduct.name}</strong>
                  <span>{scannedProduct.barcode} | {scannedProduct.category} | current stock: {scannedProduct.qty}</span>
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

        <div className="scan-feed">
          <div className="section-sub">Recently Scanned</div>
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
                </div>
                <span className="badge badge-info">+{f.qty} units</span>
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
        subtitle="Stock in by scanning existing product barcodes. Add new products first when a barcode is not found."
      />

      {stockInScanner}

      <div className="stat-grid cols-3">
        <StatCard label="Total Products" tone="indigo" icon={IconBox} value={totalProducts} foot="active SKUs" />
        <StatCard label="Low Stock Items" tone="amber" icon={IconAlert} value={lowItems} foot="below threshold" />
        <StatCard label="Total Stock Value" tone="green" icon={IconDollar} value={peso(stockValue)} foot="at cost" />
      </div>

      <div className="card fsn-card-panel">
        <div className="panel-head fsn-panel-head">
          <div>
            <h3>FSN Inventory Analysis</h3>
            <p className="sub">Classified by 90-day sales velocity and days since last sale.</p>
          </div>
        </div>
        <div className="panel-body fsn-grid-wrap">
          <div className="fsn-grid">
            <button type="button" className={`fsn-card ${selectedFsn === 'Fast-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Fast-moving')}>
              <div className="fsn-card-top">
                <div className="fsn-label">Fast-moving</div>
                <div className="fsn-icon ic-green"><IconChart size={18} /></div>
              </div>
              <div className="fsn-value">{fastProducts.length}</div>
              <div className="fsn-foot">Sold often in the last 90 days</div>
            </button>
            <button type="button" className={`fsn-card ${selectedFsn === 'Slow-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Slow-moving')}>
              <div className="fsn-card-top">
                <div className="fsn-label">Slow-moving</div>
                <div className="fsn-icon ic-amber"><IconTag size={18} /></div>
              </div>
              <div className="fsn-value">{slowProducts.length}</div>
              <div className="fsn-foot">Sold recently, but at low velocity</div>
            </button>
            <button type="button" className={`fsn-card ${selectedFsn === 'Non-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Non-moving')}>
              <div className="fsn-card-top">
                <div className="fsn-label">Non-moving</div>
                <div className="fsn-icon ic-red"><IconAlert size={18} /></div>
              </div>
              <div className="fsn-value">{nonMovingProducts.length}</div>
              <div className="fsn-foot">No sales for 90+ days or never sold</div>
            </button>
          </div>

          <div className="fsn-product-list">
            <div className="fsn-product-list-head">
              <div>{selectedFsn} Products</div>
              <span>{selectedFsn === 'Fast-moving' ? fastProducts.length : selectedFsn === 'Slow-moving' ? slowProducts.length : nonMovingProducts.length} items</span>
            </div>
            {(selectedFsn === 'Fast-moving' ? fastProducts : selectedFsn === 'Slow-moving' ? slowProducts : nonMovingProducts).map((p) => (
              <div key={p.id} className="fsn-product-row">
                <div>
                  <strong>{p.name}</strong>
                  <span>{p.fsnReason} | avg. {(Number(p.averageMonthlyUnits) || 0).toFixed(1)} unit(s)/month</span>
                </div>
                <div className="fsn-product-tags">
                  <span className={`badge ${selectedFsn === 'Fast-moving' ? 'badge-info' : selectedFsn === 'Slow-moving' ? 'badge-warning' : 'badge-danger'}`}>
                    {p.units90 || 0} sold
                  </span>
                  <span className="badge badge-neutral">{p.qty} stock</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

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
