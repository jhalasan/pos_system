import { useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { IconUsers, IconUserPlus, IconScan, IconTrash, IconEdit, IconImage } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import {
  BROWSER_PRINT_VALUE,
  listBarcodePrinters,
  printBarcodeLabels,
  saveBarcodeLabelsPdf,
  saveBarcodePrintSettings,
  savedBarcodePrintSettings,
} from '../utils/barcodePrinter'

const blank = { name: '', email: '', shift: 'Morning', status: 'active', cashierBarcode: '', password: '', passwordConfirm: '' }

function nextCashierBarcode() {
  return `81${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
}

export default function CashierManagement() {
  const { data: list, setData: setList, loading, error } = useApi(api.cashiers, [])
  const [open, setOpen] = useState(false)
  const [editingCashier, setEditingCashier] = useState(null)
  const [form, setForm] = useState(blank)
  const [imagePreview, setImagePreview] = useState('')
  const fileInputRef = useRef(null)
  const objectUrlRef = useRef('')
  const [toast, setToast] = useState('')
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [printSettings, setPrintSettings] = useState(savedBarcodePrintSettings)
  const [printers, setPrinters] = useState([])
  const [selectedCashierIds, setSelectedCashierIds] = useState([])
  const [printingBarcode, setPrintingBarcode] = useState('')
  const isEdit = Boolean(editingCashier)

  const set = (k) => (e) => {
    setFormError('')
    setForm({ ...form, [k]: e.target.value })
  }

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  useEffect(() => {
    listBarcodePrinters().then(setPrinters)
  }, [])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  function openAddCashier() {
    setEditingCashier(null)
    setForm(blank)
    setImagePreview('')
    setFormError('')
    setOpen(true)
  }

  function openEditCashier(cashier) {
    setEditingCashier(cashier)
    setForm({
      name: cashier.name || '',
      email: cashier.email || '',
      originalEmail: cashier.email || '',
      shift: cashier.shift || 'Morning',
      status: cashier.status || 'active',
      cashierBarcode: cashier.cashierBarcode || '',
      password: '',
      passwordConfirm: '',
    })
    setImagePreview(cashier.imageUrl || '')
    setFormError('')
    setOpen(true)
  }

  function closeModal() {
    setOpen(false)
    setEditingCashier(null)
    setForm(blank)
    setImagePreview('')
    setFormError('')
    setSaving(false)
  }

  function selectImage(file) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setFormError('Please upload a JPEG, PNG, or WEBP image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setFormError('Profile image must be 5MB or smaller.')
      return
    }
    setFormError('')
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = URL.createObjectURL(file)
    setImagePreview(objectUrlRef.current)
    setForm((current) => ({ ...current, imageFile: file }))
  }

  async function saveCashier() {
    if (!form.name.trim() || !form.email.trim()) {
      setFormError('Name and email are required.')
      return
    }

    if (isEdit && form.email !== form.originalEmail) {
      setFormError('Email changes for existing cashier accounts must be done in PocketBase Admin.')
      return
    }

    if (!isEdit && !form.password.trim()) {
      setFormError('Password is required for new cashiers.')
      return
    }

    if (form.password || form.passwordConfirm) {
      if (form.password.length < 8) {
        setFormError('Password must be at least 8 characters.')
        return
      }
      if (form.password !== form.passwordConfirm) {
        setFormError('Passwords do not match.')
        return
      }
    }

    const savePayload = {
      ...form,
      cashierBarcode: String(form.cashierBarcode || '').trim() || nextCashierBarcode(),
    }

    setSaving(true)
    setFormError('')
    try {
      if (isEdit) {
        const updated = await api.updateCashier(editingCashier.id, savePayload)
        setList(list.map((item) => (item.id === updated.id ? updated : item)))
        flash('Cashier updated.')
      } else {
        const created = await api.createCashier(savePayload)
        setList([...list, created])
        flash('Cashier added.')
      }
      closeModal()
    } catch (err) {
      const message = err.message || 'Unable to save cashier.'
      setFormError(message)
      flash(message)
    } finally {
      setSaving(false)
    }
  }

  async function removeCashier(c) {
    if (confirm(`Remove cashier "${c.name}"?`)) {
      try {
        await api.deleteCashier(c.id)
        setList(list.filter((x) => x.id !== c.id))
        flash('Cashier removed.')
      } catch (err) {
        flash(err.message || 'Unable to remove cashier.')
      }
    }
  }

  const active = list.filter((c) => c.status === 'active').length
  const printableCashiers = useMemo(() => list
    .filter((cashier) => String(cashier.cashierBarcode || '').trim())
    .map((cashier) => ({
      id: cashier.id,
      title: cashier.name || 'Cashier',
      value: cashier.cashierBarcode,
      meta: [cashier.cashierId || cashier.id, cashier.shift].filter(Boolean).join(' | '),
    })), [list])
  const selectedCashierBarcodes = useMemo(() => {
    const selected = new Set(selectedCashierIds)
    return printableCashiers.filter((cashier) => selected.has(cashier.id))
  }, [printableCashiers, selectedCashierIds])

  function updatePrintSettings(patch) {
    setPrintSettings(saveBarcodePrintSettings({ ...printSettings, ...patch }))
  }

  function toggleCashierSelection(id) {
    setSelectedCashierIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  function selectAllCashiers() {
    setSelectedCashierIds(printableCashiers.map((cashier) => cashier.id))
  }

  async function printCashierBarcode(cashier) {
    const code = String(cashier.cashierBarcode || '').trim()
    if (!code) {
      flash('This cashier does not have a barcode yet.')
      return
    }

    setPrintingBarcode(cashier.id)
    try {
      const result = await printBarcodeLabels({
        title: cashier.name || 'Cashier',
        value: code,
        meta: [cashier.cashierId || cashier.id, cashier.shift].filter(Boolean).join(' | '),
      }, printSettings)
      const copies = Number(result?.copies) || printSettings.copies
      if (result?.preview) {
        flash(`Preview opened for ${copies} cashier barcode label${copies === 1 ? '' : 's'}.`)
      } else {
        flash(`Sent ${copies} cashier barcode label${copies === 1 ? '' : 's'} to ${result?.printerName || 'printer'}.`)
      }
    } catch (err) {
      flash(err.message || 'Unable to print cashier barcode.')
    } finally {
      setPrintingBarcode('')
    }
  }

  async function saveCashierBarcode(cashier) {
    const code = String(cashier.cashierBarcode || '').trim()
    if (!code) {
      flash('This cashier does not have a barcode yet.')
      return
    }

    setPrintingBarcode(`save-${cashier.id}`)
    try {
      const path = await saveBarcodeLabelsPdf({
        title: cashier.name || 'Cashier',
        value: code,
        meta: [cashier.cashierId || cashier.id, cashier.shift].filter(Boolean).join(' | '),
      }, {
        ...printSettings,
        documentName: `Cashier Barcode ${cashier.name || code}`,
      })
      flash(path ? `Cashier barcode PDF saved to ${path}.` : 'Cashier barcode PDF save cancelled.')
    } catch (err) {
      flash(err.message || 'Unable to save cashier barcode PDF.')
    } finally {
      setPrintingBarcode('')
    }
  }

  async function printSelectedCashiers() {
    setPrintingBarcode('selected')
    try {
      const path = await saveBarcodeLabelsPdf(selectedCashierBarcodes, {
        ...printSettings,
        documentName: `Cashier Barcodes (${selectedCashierBarcodes.length})`,
      })
      flash(path ? `Cashier barcode PDF saved to ${path}.` : 'Cashier barcode PDF save cancelled.')
    } catch (err) {
      flash(err.message || 'Unable to print selected cashier barcode PDF.')
    } finally {
      setPrintingBarcode('')
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Cashier Management" subtitle="Loading cashier accounts..." />
        <div className="card"><div className="empty"><h4>Loading cashiers</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Cashier Management" subtitle="Manage cashier accounts, shifts, and access." />
        <div className="card"><div className="empty"><h4>Unable to load cashiers</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Cashier Management"
        subtitle="Manage cashier accounts, shifts, and access."
      >
        <label className="barcode-print-count barcode-printer-select">
          <span>Printer</span>
          <select
            className="select"
            value={printSettings.printerName || BROWSER_PRINT_VALUE}
            onChange={(e) => updatePrintSettings({ printerName: e.target.value })}
            aria-label="Cashier barcode printer"
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
            aria-label="Cashier barcode labels to print"
          />
        </label>
        <button className="btn btn-outline" onClick={selectAllCashiers} disabled={printableCashiers.length === 0}>
          Select All
        </button>
        <button className="btn btn-primary" onClick={printSelectedCashiers} disabled={selectedCashierBarcodes.length === 0 || printingBarcode === 'selected'}>
          {printingBarcode === 'selected' ? 'Saving...' : `Print Selected (${selectedCashierBarcodes.length})`}
        </button>
        <button className="btn btn-outline" onClick={() => alert('Scan a cashier ID badge to look up an account.')}>
          <IconScan size={16} /> Scan ID
        </button>
        <button className="btn btn-primary" onClick={openAddCashier}>
          <IconUserPlus size={16} /> Add Cashier
        </button>
      </PageHeader>

      <div className="stat-grid cols-3">
        <StatCard label="Total Cashiers" tone="indigo" icon={IconUsers} value={list.length} foot="registered accounts" />
        <StatCard label="Active" tone="green" icon={IconUsers} value={active} foot="currently enabled" />
        <StatCard label="Inactive" tone="amber" icon={IconUsers} value={list.length - active} foot="disabled accounts" />
      </div>

      <div className="card">
        <div className="panel-head">
          <h3>Cashier Accounts</h3>
          <span className="sub">{list.length} total</span>
        </div>

        {list.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconUsers size={26} /></div>
            <h4>No cashiers added yet</h4>
            <p>Click the button below to register your first cashier.</p>
            <button className="btn btn-primary" onClick={openAddCashier}>
              <IconUserPlus size={16} /> Add Cashier
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="t-center">Select</th>
                  <th>Cashier</th>
                  <th>Cashier ID</th>
                  <th>Barcode</th>
                  <th>Shift</th>
                  <th>Total Sales</th>
                  <th>Status</th>
                  <th className="t-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td className="t-center">
                      <input
                        type="checkbox"
                        checked={selectedCashierIds.includes(c.id)}
                        onChange={() => toggleCashierSelection(c.id)}
                        disabled={!c.cashierBarcode}
                        aria-label={`Select ${c.name} barcode`}
                      />
                    </td>
                    <td>
                      <div className="prod-cell">
                        <div className="user-chip" style={{ border: 'none', padding: 0 }}>
                          {c.imageUrl ? (
                            <div className="av cashier-avatar"><img src={c.imageUrl} alt={c.name} /></div>
                          ) : (
                            <div className="av">{c.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</div>
                          )}
                        </div>
                        <div>
                          <div className="prod-name">{c.name}</div>
                          <div className="prod-id">{c.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{c.cashierId || c.id}</td>
                    <td className="mono">{c.cashierBarcode || '-'}</td>
                    <td>{c.shift}</td>
                    <td>{peso(c.sales)}</td>
                    <td>
                      <span className={'badge ' + (c.status === 'active' ? 'badge-success' : 'badge-neutral')}>
                        {c.status === 'active' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-btn" title="Edit" onClick={() => openEditCashier(c)}>
                          <IconEdit size={15} />
                        </button>
                        <button
                          className="btn btn-outline cashier-print-btn"
                          title="Print cashier barcode"
                          onClick={() => printCashierBarcode(c)}
                          disabled={printingBarcode === c.id}
                        >
                          <IconScan size={15} /> {printingBarcode === c.id ? 'Printing...' : 'Print'}
                        </button>
                        <button
                          className="btn btn-outline cashier-print-btn"
                          title="Save cashier barcode PDF"
                          onClick={() => saveCashierBarcode(c)}
                          disabled={printingBarcode === `save-${c.id}`}
                        >
                          {printingBarcode === `save-${c.id}` ? 'Saving...' : 'Save PDF'}
                        </button>
                        <button className="icon-btn del" title="Remove" onClick={() => removeCashier(c)}>
                          <IconTrash size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <Modal
          title={isEdit ? 'Edit Cashier' : 'Add Cashier'}
          onClose={closeModal}
          footer={
            <>
              <button className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={saveCashier} disabled={saving}>
                {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Cashier'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            {formError && <div className="alert error span-2">{formError}</div>}
            <div className="field span-2">
              <label>Profile Picture</label>
              <button
                type="button"
                className={`img-drop ${imagePreview ? 'has-image' : ''}`}
                onClick={() => fileInputRef.current?.click()}
              >
                {imagePreview ? (
                  <>
                    <img src={imagePreview} alt={`${form.name || 'Cashier'} profile preview`} />
                    <span>Click to replace profile picture</span>
                  </>
                ) : (
                  <>
                    <div className="di"><IconImage size={20} /></div>
                    Click to upload cashier profile picture
                  </>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => selectImage(e.target.files?.[0])}
              />
            </div>
            <div className="field span-2">
              <label>Full Name</label>
              <input className="input" placeholder="e.g. Maria Santos" value={form.name} onChange={set('name')} />
            </div>
            <div className="field span-2">
              <label>Email Address</label>
              <input
                className="input"
                type="email"
                placeholder="name@example.com"
                value={form.email}
                onChange={set('email')}
                disabled={isEdit}
              />
            </div>
            <div className="field span-2">
              <label>Cashier Login Barcode</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <input
                  className="input"
                  placeholder="Scan or generate cashier barcode"
                  value={form.cashierBarcode || ''}
                  onChange={set('cashierBarcode')}
                />
                <button type="button" className="btn btn-outline" onClick={() => setForm((current) => ({ ...current, cashierBarcode: nextCashierBarcode() }))}>
                  Generate
                </button>
              </div>
            </div>
            <div className="field">
              <label>Shift</label>
              <select className="select" value={form.shift} onChange={set('shift')}>
                {['Morning', 'Afternoon', 'Evening'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select className="select" value={form.status} onChange={set('status')}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            {!isEdit && (
              <>
                <div className="field">
                  <label>Password</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="At least 8 characters"
                    value={form.password}
                    onChange={set('password')}
                  />
                </div>
                <div className="field">
                  <label>Confirm Password</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Repeat password"
                    value={form.passwordConfirm}
                    onChange={set('passwordConfirm')}
                  />
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconUserPlus size={15} /> {toast}</div>}
    </>
  )
}
