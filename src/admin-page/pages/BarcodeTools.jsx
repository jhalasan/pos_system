import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Modal from '../components/Modal'
import ProductModal from '../components/ProductModal'
import { IconBarcode, IconCheck, IconLock, IconPlus, IconShield, IconTag, IconTrash } from '../components/Icons'
import { currentAdminUser } from '../auth'
import { api, defaultCategories } from '../services/api'
import { useApi } from '../hooks/useApi'
import { code128Bars } from '../utils/code128Barcode'
import {
  BROWSER_PRINT_VALUE,
  listBarcodePrinters,
  printBarcodeLabels,
  saveBarcodeLabelsPdf,
  saveBarcodePrintSettings,
  savedBarcodePrintSettings,
} from '../utils/barcodePrinter'

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
  const [printSettings, setPrintSettings] = useState(savedBarcodePrintSettings)
  const [printers, setPrinters] = useState([])
  const [selectedBarcodeIds, setSelectedBarcodeIds] = useState([])
  const [printingBarcode, setPrintingBarcode] = useState('')
  const [toast, setToast] = useState('')

  const categories = useMemo(() => {
    return [...new Set([...defaultCategories, ...products.map((product) => product.category).filter(Boolean)])]
  }, [products])

  const generatedProducts = useMemo(() => {
    return products
      .filter((product) => String(product.barcode || '').startsWith('29'))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [products])

  const printableBarcodes = useMemo(() => [
    ...generatedProducts.map((product) => ({
      id: `product-${product.id}`,
      title: product.name,
      value: product.barcode,
      meta: [product.category || 'Uncategorized', product.unit].filter(Boolean).join(' | '),
    })),
    ...authCodes
      .filter((code) => code.status === 'active')
      .map((code) => ({
        id: `auth-${code.id}`,
        title: code.label || 'Void and Discount Approval',
        value: code.barcode,
        meta: `Generated by ${code.generatedBy || 'Admin'}`,
      })),
  ], [authCodes, generatedProducts])

  const selectedBarcodes = useMemo(() => {
    const selected = new Set(selectedBarcodeIds)
    return printableBarcodes.filter((barcode) => selected.has(barcode.id))
  }, [printableBarcodes, selectedBarcodeIds])

  useEffect(() => {
    listBarcodePrinters().then((availablePrinters) => {
      setPrinters(availablePrinters)
      if (savedBarcodePrintSettings().printerName === BROWSER_PRINT_VALUE && availablePrinters.length > 0) {
        const defaultPrinter = availablePrinters.find((printer) => printer.isDefault) || availablePrinters[0]
        setPrintSettings(saveBarcodePrintSettings({ printerName: defaultPrinter.name }))
      }
    })
  }, [])

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

  function updatePrintSettings(patch) {
    setPrintSettings(saveBarcodePrintSettings({ ...printSettings, ...patch }))
  }

  function toggleBarcodeSelection(id) {
    setSelectedBarcodeIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  function selectAllBarcodes() {
    setSelectedBarcodeIds(printableBarcodes.map((barcode) => barcode.id))
  }

  async function handlePrintBarcode(id, title, value, meta = '') {
    setPrintingBarcode(id)
    try {
      const result = await printBarcodeLabels({ title, value, meta }, printSettings)
      const copies = Number(result?.copies) || printSettings.copies
      if (result?.preview) {
        flash(`Preview opened for ${copies} barcode label${copies === 1 ? '' : 's'}.`)
      } else {
        flash(`Sent ${copies} barcode label${copies === 1 ? '' : 's'} to ${result?.printerName || 'printer'}.`)
      }
    } catch (err) {
      flash(err.message || 'Unable to print barcode.')
    } finally {
      setPrintingBarcode('')
    }
  }

  async function handleSaveBarcode(id, title, value, meta = '') {
    setPrintingBarcode(`save-${id}`)
    try {
      const path = await saveBarcodeLabelsPdf({ title, value, meta }, {
        ...printSettings,
        documentName: `Barcode ${value}`,
      })
      flash(path ? `Barcode PDF saved to ${path}.` : 'Barcode PDF save cancelled.')
    } catch (err) {
      flash(err.message || 'Unable to save barcode PDF.')
    } finally {
      setPrintingBarcode('')
    }
  }

  async function handlePrintSelected() {
    setPrintingBarcode('selected')
    try {
      const path = await saveBarcodeLabelsPdf(selectedBarcodes, {
        ...printSettings,
        documentName: `Selected Barcodes (${selectedBarcodes.length})`,
      })
      flash(path ? `Selected barcode PDF saved to ${path}.` : 'Selected barcode PDF save cancelled.')
    } catch (err) {
      flash(err.message || 'Unable to print selected barcode PDF.')
    } finally {
      setPrintingBarcode('')
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
        <label className="barcode-print-count barcode-printer-select">
          <span>Printer</span>
          <select
            className="select"
            value={printSettings.printerName || BROWSER_PRINT_VALUE}
            onChange={(e) => updatePrintSettings({ printerName: e.target.value })}
            aria-label="Barcode printer"
          >
            <option value={BROWSER_PRINT_VALUE}>Print dialog / sheet</option>
            {printSettings.printerName && printSettings.printerName !== BROWSER_PRINT_VALUE && !printers.some((printer) => printer.name === printSettings.printerName) && (
              <option value={printSettings.printerName}>{printSettings.printerName}</option>
            )}
            {printers.map((printer) => (
              <option key={printer.name} value={printer.name}>
                {printer.name}{printer.isDefault ? ' (Default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="barcode-print-count">
          <span>Labels</span>
          <input
            className="input"
            type="number"
            min="1"
            max="99"
            value={printSettings.copies}
            onChange={(e) => updatePrintSettings({ copies: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
            aria-label="Barcode labels to print"
          />
        </label>
        <button className="btn btn-outline" onClick={selectAllBarcodes} disabled={printableBarcodes.length === 0}>
          Select All
        </button>
        <button className="btn btn-primary" onClick={handlePrintSelected} disabled={selectedBarcodes.length === 0 || printingBarcode === 'selected'}>
          {printingBarcode === 'selected' ? 'Saving...' : `Print Selected (${selectedBarcodes.length})`}
        </button>
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
                  <label className="barcode-select-check" title="Select barcode">
                    <input
                      type="checkbox"
                      checked={selectedBarcodeIds.includes(`product-${product.id}`)}
                      onChange={() => toggleBarcodeSelection(`product-${product.id}`)}
                    />
                  </label>
                  <div className="barcode-record">
                    <strong>{product.name}</strong>
                    <span>{product.category || 'Uncategorized'} | {product.unit} | {product.qty} in stock</span>
                    <BarcodePreview value={product.barcode} />
                  </div>
                  <div className="barcode-actions">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => handlePrintBarcode(
                        `product-${product.id}`,
                        product.name,
                        product.barcode,
                        [product.category || 'Uncategorized', product.unit].filter(Boolean).join(' | '),
                      )}
                      disabled={printingBarcode === `product-${product.id}`}
                    >
                      {printingBarcode === `product-${product.id}` ? 'Printing...' : 'Print'}
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => handleSaveBarcode(
                        `product-${product.id}`,
                        product.name,
                        product.barcode,
                        [product.category || 'Uncategorized', product.unit].filter(Boolean).join(' | '),
                      )}
                      disabled={printingBarcode === `save-product-${product.id}`}
                    >
                      {printingBarcode === `save-product-${product.id}` ? 'Saving...' : 'Save PDF'}
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
                    <label className="barcode-select-check" title="Select barcode">
                      <input
                        type="checkbox"
                        checked={selectedBarcodeIds.includes(`auth-${code.id}`)}
                        onChange={() => toggleBarcodeSelection(`auth-${code.id}`)}
                        disabled={code.status !== 'active'}
                      />
                    </label>
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
                        onClick={() => handlePrintBarcode(`auth-${code.id}`, code.label || 'Void and Discount Approval', code.barcode, `Generated by ${code.generatedBy || 'Admin'}`)}
                        disabled={code.status !== 'active' || printingBarcode === `auth-${code.id}`}
                      >
                        {printingBarcode === `auth-${code.id}` ? 'Printing...' : 'Print'}
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => handleSaveBarcode(`auth-${code.id}`, code.label || 'Void and Discount Approval', code.barcode, `Generated by ${code.generatedBy || 'Admin'}`)}
                        disabled={code.status !== 'active' || printingBarcode === `save-auth-${code.id}`}
                      >
                        {printingBarcode === `save-auth-${code.id}` ? 'Saving...' : 'Save PDF'}
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
