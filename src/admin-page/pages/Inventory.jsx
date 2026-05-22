import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import { IconBox, IconAlert, IconDollar, IconScan, IconCheck, IconTag, IconChart } from '../components/Icons'
import { products, peso } from '../data/mockData'

export default function Inventory() {
  const [barcode, setBarcode] = useState('')
  const [qty, setQty] = useState(1)
  const [feed, setFeed] = useState([])
  const [error, setError] = useState('')

  const totalProducts = products.length
  const lowItems = products.filter((p) => p.status !== 'in-stock').length
  const stockValue = products.reduce((s, p) => s + p.qty * p.price, 0)

  const fastProducts = products.filter((p) => p.qty >= 80)
  const slowProducts = products.filter((p) => p.qty >= 20 && p.qty < 80)
  const nonMovingProducts = products.filter((p) => p.qty < 20)
  const [selectedFsn, setSelectedFsn] = useState('Fast-moving')

  function scan(e) {
    e.preventDefault()
    const code = barcode.trim()
    if (!code) return
    const match = products.find((p) => p.barcode === code)
    if (!match) {
      setError(`No product found for barcode "${code}".`)
      return
    }
    setFeed((f) => [
      { key: Date.now(), name: match.name, id: match.id, qty: Number(qty) || 1, time: new Date() },
      ...f,
    ])
    setBarcode('')
    setQty(1)
    setError('')
  }

  const scannedUnits = feed.reduce((s, f) => s + f.qty, 0)

  return (
    <>
      <PageHeader
        title="Inventory Scanner"
        subtitle="Scan barcodes to add stock and monitor inventory health."
      />

      <div className="stat-grid cols-3">
        <StatCard label="Total Products" tone="indigo" icon={IconBox} value={totalProducts} foot="active SKUs" />
        <StatCard label="Low Stock Items" tone="amber" icon={IconAlert} value={lowItems} foot="below threshold" />
        <StatCard label="Total Stock Value" tone="green" icon={IconDollar} value={peso(stockValue)} foot="at cost" />
      </div>

      <div className="card fsn-card-panel">
        <div className="panel-head fsn-panel-head">
          <div>
            <h3>FSN Inventory Analysis</h3>
            <p className="sub">Fast, Slow, and Non-moving product classification for smarter stocking decisions.</p>
          </div>
        </div>
        <div className="panel-body fsn-grid-wrap">
          <div className="fsn-grid">
            <button
              type="button"
              className={`fsn-card ${selectedFsn === 'Fast-moving' ? 'active' : ''}`}
              onClick={() => setSelectedFsn('Fast-moving')}
            >
              <div className="fsn-card-top">
                <div className="fsn-label">Fast-moving</div>
                <div className="fsn-icon ic-green"><IconChart size={18} /></div>
              </div>
              <div className="fsn-value">{fastProducts.length}</div>
              <div className="fsn-foot">{fastProducts.slice(0, 3).map((p) => p.name).join(', ') || 'No fast items'}</div>
            </button>
            <button
              type="button"
              className={`fsn-card ${selectedFsn === 'Slow-moving' ? 'active' : ''}`}
              onClick={() => setSelectedFsn('Slow-moving')}
            >
              <div className="fsn-card-top">
                <div className="fsn-label">Slow-moving</div>
                <div className="fsn-icon ic-amber"><IconTag size={18} /></div>
              </div>
              <div className="fsn-value">{slowProducts.length}</div>
              <div className="fsn-foot">{slowProducts.slice(0, 3).map((p) => p.name).join(', ') || 'No slow items'}</div>
            </button>
            <button
              type="button"
              className={`fsn-card ${selectedFsn === 'Non-moving' ? 'active' : ''}`}
              onClick={() => setSelectedFsn('Non-moving')}
            >
              <div className="fsn-card-top">
                <div className="fsn-label">Non-moving</div>
                <div className="fsn-icon ic-red"><IconAlert size={18} /></div>
              </div>
              <div className="fsn-value">{nonMovingProducts.length}</div>
              <div className="fsn-foot">{nonMovingProducts.slice(0, 3).map((p) => p.name).join(', ') || 'No non-moving items'}</div>
            </button>
          </div>

          <div className="fsn-product-list">
            <div className="fsn-product-list-head">
              <div>{selectedFsn} Products</div>
              <span>{selectedFsn === 'Fast-moving' ? fastProducts.length : selectedFsn === 'Slow-moving' ? slowProducts.length : nonMovingProducts.length} items</span>
            </div>
            {(selectedFsn === 'Fast-moving' ? fastProducts : selectedFsn === 'Slow-moving' ? slowProducts : nonMovingProducts).map((p) => (
              <div key={p.id} className="fsn-product-row">
                <div>{p.name}</div>
                <div className={`badge ${selectedFsn === 'Fast-moving' ? 'badge-info' : selectedFsn === 'Slow-moving' ? 'badge-warning' : 'badge-danger'}`}>
                  {p.category}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <h3>Scan Items</h3>
          <span className="sub">{scannedUnits} unit(s) staged this session</span>
        </div>
        <div className="panel-body">
          <div className="scan-flow">
            <IconScan size={16} />
            <span>
              Workflow: <b>1.</b> Scan barcode → <b>2.</b> Enter quantity → <b>3.</b> Press Enter to add to stock.
            </span>
          </div>

          <form className="scan-grid" onSubmit={scan}>
            <div className="field">
              <label><span className="scan-step-no">1</span>Scan Barcode</label>
              <input
                className="input"
                placeholder="Scan or type barcode (e.g. 4800101234567)"
                value={barcode}
                onChange={(e) => { setBarcode(e.target.value); setError('') }}
                autoFocus
              />
            </div>
            <div className="field">
              <label><span className="scan-step-no">2</span>Quantity</label>
              <input
                className="input"
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ height: 38 }}>
              <span className="scan-step-no" style={{ background: 'rgba(255,255,255,.3)' }}>3</span>
              Add to Stock
            </button>
          </form>

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600, marginTop: 10 }}>
              {error}
            </p>
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
                    <div className="prod-id">{f.id}</div>
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
    </>
  )
}
