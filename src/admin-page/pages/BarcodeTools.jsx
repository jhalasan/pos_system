import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Modal from '../components/Modal'
import ProductModal from '../components/ProductModal'
import { IconBarcode, IconCheck, IconLock, IconPlus, IconShield, IconTag, IconTrash } from '../components/Icons'
import { currentAdminUser } from '../auth'
import { api, defaultCategories } from '../services/api'
import { useApi } from '../hooks/useApi'
import { code128Bars, escapeHtml } from '../utils/code128Barcode'

function BarcodePreview({ value }) {
  const { bars, width } = code128Bars(value)
  if (!String(value || '').trim()) return <div className="barcode-empty">No barcode generated</div>

  return (
    <div className="barcode-preview">
      <svg className="barcode-svg" viewBox={`0 0 ${width} 62`} preserveAspectRatio="none" aria-label={`Barcode ${value}`}>
        {bars.map((bar, index) => (
          <rect key={`${bar.x}-${index}`} x={bar.x} y="0" width={bar.width} height="48" fill="currentColor" />
        ))}
      </svg>
      <div className="barcode-value mono">{value}</div>
    </div>
  )
}

function printBarcode(title, value) {
  const { bars, width } = code128Bars(value)
  const rects = bars.map((bar) => `<rect x="${bar.x}" y="0" width="${bar.width}" height="70" fill="#111827" />`).join('')
  const popup = window.open('', '_blank', 'width=420,height=320')
  if (!popup) return
  popup.document.write(`
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 24px; color: #111827; }
          .label { width: 320px; border: 1px solid #d1d5db; padding: 18px; text-align: center; }
          h1 { font-size: 16px; margin: 0 0 14px; }
          svg { width: 100%; height: 86px; display: block; }
          .code { font-family: Consolas, monospace; font-size: 14px; margin-top: 8px; letter-spacing: 1px; }
        </style>
      </head>
      <body>
        <div class="label">
          <h1>${escapeHtml(title)}</h1>
          <svg viewBox="0 0 ${width} 78" preserveAspectRatio="none">${rects}</svg>
          <div class="code">${escapeHtml(value)}</div>
        </div>
      </body>
    </html>
  `)
  popup.document.close()
  popup.focus()
  popup.print()
}

function normalizeAuthorizationCode(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Authorization barcode generation returned an empty response.')
  }

  const id = String(result.id || '').trim()
  const barcode = String(result.barcode || '').trim()
  if (!id || !barcode) {
    throw new Error('Authorization barcode generation returned incomplete data.')
  }

  return {
    id,
    barcode,
    label: String(result.label || 'Void and Discount Approval').trim(),
    status: String(result.status || 'active').trim() || 'active',
    generatedBy: String(result.generatedBy || 'Admin').trim() || 'Admin',
    createdAt: result.createdAt || new Date().toISOString(),
  }
}

function AuthorizationModal({ email, onClose, onGenerated }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!password.trim()) {
      setError('Admin password is required.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const result = await api.generateAuthorizationBarcode(email, password)
      onGenerated(normalizeAuthorizationCode(result))
    } catch (err) {
      setError(err.message || 'Unable to generate authorization barcode.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="Generate Authorization Barcode"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            <IconShield size={15} /> Generate
          </button>
        </>
      }
    >
      <div className="auth-barcode-modal">
        <div className="scan-flow">
          <IconLock size={16} />
          <span>Enter the current admin password. The generated barcode can approve voids and discounts.</span>
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="field">
          <label>Admin Email</label>
          <input className="input" value={email} disabled />
        </div>
        <div className="field">
          <label>Admin Password</label>
          <input
            className="input"
            type="password"
            placeholder="Enter admin password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            autoFocus
          />
        </div>
      </div>
    </Modal>
  )
}

export default function BarcodeTools() {
  const { data: products, setData: setProducts, loading, error } = useApi(api.products, [])
  const {
    data: authCodes,
    setData: setAuthCodes,
    loading: authLoading,
    error: authError,
  } = useApi(api.authorizationBarcodes, [])
  const admin = currentAdminUser()
  const [productModal, setProductModal] = useState(null)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [generatingProduct, setGeneratingProduct] = useState(false)
  const [toast, setToast] = useState('')

  const categories = useMemo(() => {
    return [...new Set([...defaultCategories, ...products.map((product) => product.category).filter(Boolean)])]
  }, [products])

  const generatedProducts = useMemo(() => {
    return products
      .filter((product) => String(product.barcode || '').startsWith('29'))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [products])

  function flash(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function openProductGenerator() {
    setGeneratingProduct(true)
    try {
      const { barcode } = await api.nextProductBarcode()
      setProductModal({
        name: '',
        barcode,
        category: categories[0] || defaultCategories[0],
        unit: 'Piece',
        qty: 0,
        lowStock: 10,
        price: 0,
        tiers: [{ label: 'Retail', price: '0.00' }],
      })
    } catch (err) {
      flash(err.message || 'Unable to generate product barcode.')
    } finally {
      setGeneratingProduct(false)
    }
  }

  async function createGeneratedProduct(data) {
    try {
      const created = await api.createProduct(data)
      setProducts([created, ...products])
      setProductModal(null)
      flash(`Generated barcode and added ${created.name}.`)
    } catch (err) {
      flash(err.message || 'Unable to create product barcode.')
    }
  }

  function handleAuthorizationGenerated(result) {
    try {
      const normalized = normalizeAuthorizationCode(result)
      setAuthCodes([normalized, ...authCodes.filter((item) => item.id !== normalized.id)])
      setAuthModalOpen(false)
      flash('Authorization barcode generated.')
    } catch (err) {
      flash(err.message || 'Unable to use the generated authorization barcode.')
    }
  }

  async function toggleAuthorization(code) {
    const nextStatus = code.status === 'active' ? 'revoked' : 'active'
    try {
      const updated = await api.updateAuthorizationBarcodeStatus(code.id, nextStatus)
      setAuthCodes(authCodes.map((item) => (item.id === code.id ? updated : item)))
      flash(`${nextStatus === 'active' ? 'Enabled' : 'Disabled'} authorization barcode.`)
    } catch (err) {
      flash(err.message || 'Unable to update authorization barcode.')
    }
  }

  async function deleteAuthorization(code) {
    if (!confirm(`Delete authorization barcode ${code.barcode}? This cannot be undone.`)) return
    try {
      await api.deleteAuthorizationBarcode(code.id)
      setAuthCodes(authCodes.filter((item) => item.id !== code.id))
      flash('Authorization barcode deleted.')
    } catch (err) {
      flash(err.message || 'Unable to delete authorization barcode.')
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Barcode Tools" subtitle="Loading barcode tools..." />
        <div className="card"><div className="empty"><h4>Loading barcode records</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Barcode Tools" subtitle="Generate product and authorization barcodes." />
        <div className="card"><div className="empty"><h4>Unable to load barcode tools</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Barcode Tools"
        subtitle="Generate internal product barcodes and authorization barcodes for voids and discounts."
      >
        <button className="btn btn-outline" onClick={() => setAuthModalOpen(true)} disabled={!admin?.email}>
          <IconShield size={16} /> Generate Authorization Barcode
        </button>
        <button className="btn btn-primary" onClick={openProductGenerator} disabled={generatingProduct}>
          <IconPlus size={16} /> Generate a Barcode
        </button>
      </PageHeader>

      <div className="barcode-grid">
        <section className="card barcode-card">
          <div className="panel-head">
            <div>
              <h3>Product Barcode Generator</h3>
              <span className="sub">Create product records for items without printed barcodes, such as cigarette sticks or single candies.</span>
            </div>
            <span className="stat-icon ic-indigo"><IconBarcode size={18} /></span>
          </div>
          <div className="panel-body">
            <div className="barcode-action-panel">
              <div>
                <strong>Generate and register an item barcode</strong>
                <span>The generated code is saved as a normal product barcode, so the cashier can scan it like any other item.</span>
              </div>
              <button className="btn btn-primary" onClick={openProductGenerator} disabled={generatingProduct}>
                <IconPlus size={16} /> Generate a Barcode
              </button>
            </div>

            <div className="section-sub">Generated Product Barcodes</div>
            <div className="barcode-list">
              {generatedProducts.length === 0 ? (
                <div className="empty" style={{ padding: '34px 20px' }}>
                  <div className="em-icon"><IconTag size={24} /></div>
                  <h4>No generated product barcodes yet</h4>
                  <p>Use the generate button to create one for loose or repacked products.</p>
                </div>
              ) : generatedProducts.map((product) => (
                <div className="barcode-row" key={product.id}>
                  <div className="barcode-record">
                    <strong>{product.name}</strong>
                    <span>{product.category || 'Uncategorized'} | {product.unit} | {product.qty} in stock</span>
                    <BarcodePreview value={product.barcode} />
                  </div>
                  <div className="barcode-actions">
                    <button className="btn btn-outline btn-sm" onClick={() => printBarcode(product.name, product.barcode)}>
                      Print
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card barcode-card">
          <div className="panel-head">
            <div>
              <h3>Authorization Barcode</h3>
              <span className="sub">Generate a scanner code for manager-level discount and void approval.</span>
            </div>
            <span className="stat-icon ic-green"><IconShield size={18} /></span>
          </div>
          <div className="panel-body">
            <div className="barcode-action-panel">
              <div>
                <strong>Password required before generation</strong>
                <span>The cashier can scan the printed code when the POS asks for approval.</span>
              </div>
              <button className="btn btn-outline" onClick={() => setAuthModalOpen(true)} disabled={!admin?.email}>
                <IconLock size={16} /> Generate Authorization Barcode
              </button>
            </div>

            <div className="section-sub">Authorization Barcodes</div>
            {authLoading ? (
              <div className="empty" style={{ padding: '34px 20px' }}>
                <div className="em-icon"><IconShield size={24} /></div>
                <h4>Loading authorization barcodes</h4>
              </div>
            ) : authError ? (
              <div className="empty" style={{ padding: '34px 20px' }}>
                <div className="em-icon"><IconLock size={24} /></div>
                <h4>Unable to load authorization barcode</h4>
                <p>{authError}</p>
              </div>
            ) : authCodes.length > 0 ? (
              <div className="barcode-list">
                {authCodes.map((code) => (
                  <div className="barcode-row auth-code-row" key={code.id}>
                    <div className="barcode-record">
                      <div className="barcode-record-head">
                        <strong>{code.label || 'Void and Discount Approval'}</strong>
                        <span className={'badge ' + (code.status === 'active' ? 'badge-success' : 'badge-neutral')}>
                          {code.status === 'active' ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                      <span>Generated by {code.generatedBy}</span>
                      <BarcodePreview value={code.barcode} />
                    </div>
                    <div className="barcode-actions auth-code-actions">
                      <label className="switch" title={code.status === 'active' ? 'Disable barcode' : 'Enable barcode'}>
                        <input
                          type="checkbox"
                          checked={code.status === 'active'}
                          onChange={() => toggleAuthorization(code)}
                        />
                        <span />
                      </label>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => printBarcode('Void and Discount Approval', code.barcode)}
                        disabled={code.status !== 'active'}
                      >
                        Print
                      </button>
                      <button className="icon-btn del" title="Delete barcode" onClick={() => deleteAuthorization(code)}>
                        <IconTrash size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty" style={{ padding: '34px 20px' }}>
                <div className="em-icon"><IconCheck size={24} /></div>
                <h4>No authorization barcode generated yet</h4>
                <p>Generate one after confirming the admin password.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      {productModal && (
        <ProductModal
          mode="add"
          product={productModal}
          categories={categories}
          onClose={() => setProductModal(null)}
          onSave={createGeneratedProduct}
        />
      )}

      {authModalOpen && (
        <AuthorizationModal
          email={admin?.email || ''}
          onClose={() => setAuthModalOpen(false)}
          onGenerated={handleAuthorizationGenerated}
        />
      )}

      {toast && <div className="toast"><IconBarcode size={15} /> {toast}</div>}
    </>
  )
}
