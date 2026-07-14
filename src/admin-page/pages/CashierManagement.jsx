import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { useAppDialog } from '../../components/AppDialogProvider'
import { IconUsers, IconUserPlus, IconScan, IconTrash, IconEdit, IconImage, IconDownload } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import {
  BROWSER_PRINT_VALUE,
  barcodeSvg,
  listBarcodePrinters,
  printBarcodeLabels,
  saveBarcodeLabelsPdf,
  saveBarcodePrintSettings,
  savedBarcodePrintSettings,
  selectBarcodePdfDirectory,
} from '../utils/barcodePrinter'

const cashierCapabilities = [
  ['process_sales', 'Process sales'],
  ['receipt_reprint', 'Reprint receipts'],
  ['refunds', 'Request refunds'],
  ['exchanges', 'Request exchanges'],
  ['voids', 'Request transaction voids'],
  ['cash_drawer', 'Record cash in/out'],
]
const defaultCashierPermissions = cashierCapabilities.map(([value]) => value)
const blank = { name: '', email: '', shift: 'Morning', status: 'active', cashierBarcode: '', password: '', passwordConfirm: '', role: 'cashier', permissions: defaultCashierPermissions }

function nextStaffBarcode(role = 'cashier') {
  const prefix = role === 'manager' ? '92' : '81'
  return `${prefix}${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
}

export default function CashierManagement() {
  const dialog = useAppDialog()
  const [activeTab, setActiveTab] = useState('cashier')
  const loadStaff = useCallback(() => api.staff ? api.staff(activeTab) : api.cashiers(), [activeTab])
  const { data: list, setData: setList, loading, error } = useApi(loadStaff, [])
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
  const [barcodePreview, setBarcodePreview] = useState(null)
  const isEdit = Boolean(editingCashier)
  const isManagerTab = activeTab === 'manager'
  const staffNoun = isManagerTab ? 'Manager' : 'Cashier'
  const staffNounPlural = isManagerTab ? 'Managers' : 'Cashiers'

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
    listBarcodePrinters().then((availablePrinters) => {
      setPrinters(availablePrinters)
      if (savedBarcodePrintSettings().printerName === BROWSER_PRINT_VALUE && availablePrinters.length > 0) {
        const defaultPrinter = availablePrinters.find((printer) => printer.isDefault) || availablePrinters[0]
        setPrintSettings(saveBarcodePrintSettings({ printerName: defaultPrinter.name }))
      }
    })
  }, [])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  function switchStaffTab(role) {
    setActiveTab(role)
    setSelectedCashierIds([])
    setBarcodePreview(null)
  }

  function openAddCashier() {
    setEditingCashier(null)
    setForm({ ...blank, role: activeTab, shift: 'Morning' })
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
      role: cashier.role || activeTab,
      permissions: Array.isArray(cashier.permissions) && cashier.permissions.length ? cashier.permissions : defaultCashierPermissions,
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

  function togglePermission(permission) {
    setForm((current) => ({ ...current, permissions: current.permissions.includes(permission) ? current.permissions.filter((item) => item !== permission) : [...current.permissions, permission] }))
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
      setFormError(`Email changes for existing ${staffNoun.toLowerCase()} accounts must be done in PocketBase Admin.`)
      return
    }

    if (!isEdit && !form.password.trim()) {
      setFormError(`Password is required for new ${staffNoun.toLowerCase()}s.`)
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

    const rawBarcode = String(form.cashierBarcode || '').trim() || nextStaffBarcode(activeTab)
    const staffBarcode = isManagerTab && !rawBarcode.startsWith('92') ? `92${rawBarcode}` : rawBarcode
    const savePayload = {
      ...form,
      role: activeTab,
      shift: form.shift || 'Morning',
      cashierBarcode: staffBarcode,
    }

    setSaving(true)
    setFormError('')
    try {
      if (isEdit) {
        const updated = await api.updateCashier(editingCashier.id, savePayload)
        setList(list.map((item) => (item.id === updated.id ? updated : item)))
        flash(`${staffNoun} updated.`)
      } else {
        const created = await api.createCashier(savePayload)
        setList([...list, created])
        flash(`${staffNoun} added.`)
      }
      closeModal()
    } catch (err) {
      const message = err.message || `Unable to save ${staffNoun.toLowerCase()}.`
      setFormError(message)
      flash(message)
    } finally {
      setSaving(false)
    }
  }

  async function removeCashier(c) {
    if (await dialog.confirm(`Remove ${staffNoun.toLowerCase()} “${c.name}”?`, { title: `Remove ${staffNoun}`, confirmLabel: 'Remove' })) {
      try {
        await api.deleteCashier(c.id)
        setList(list.filter((x) => x.id !== c.id))
        flash(`${staffNoun} removed.`)
      } catch (err) {
        flash(err.message || `Unable to remove ${staffNoun.toLowerCase()}.`)
      }
    }
  }

  const active = list.filter((c) => c.status === 'active').length
  const printableCashiers = useMemo(() => list
    .filter((cashier) => String(cashier.cashierBarcode || '').trim())
    .map((cashier) => ({
      id: cashier.id,
      title: cashier.name || staffNoun,
      value: cashier.cashierBarcode,
      meta: [cashier.cashierId || cashier.id, isManagerTab ? 'Manager approval' : cashier.shift].filter(Boolean).join(' | '),
    })), [isManagerTab, list, staffNoun])
  const selectedCashierBarcodes = useMemo(() => {
    const selected = new Set(selectedCashierIds)
    return printableCashiers.filter((cashier) => selected.has(cashier.id))
  }, [printableCashiers, selectedCashierIds])
  const allPrintableSelected = printableCashiers.length > 0 && printableCashiers.every((cashier) => selectedCashierIds.includes(cashier.id))
  const somePrintableSelected = selectedCashierBarcodes.length > 0

  function updatePrintSettings(patch) {
    setPrintSettings(saveBarcodePrintSettings({ ...printSettings, ...patch }))
  }

  async function chooseBarcodeFolder() {
    try {
      const folder = await selectBarcodePdfDirectory()
      if (folder) {
        updatePrintSettings({ pdfDirectory: folder })
        flash(`${staffNoun} barcode folder saved.`)
      }
    } catch (err) {
      flash(err.message || 'Unable to select barcode folder.')
    }
  }

  function toggleCashierSelection(id) {
    setSelectedCashierIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  function toggleAllCashiers() {
    setSelectedCashierIds(allPrintableSelected ? [] : printableCashiers.map((cashier) => cashier.id))
  }

  function cashierPrintSettings() {
    return { ...printSettings, preview: false }
  }

  function openBarcodePreview(labels, documentName) {
    setBarcodePreview({
      labels: Array.isArray(labels) ? labels : [labels],
      documentName,
    })
  }

  async function printCashierBarcode(cashier) {
    const code = String(cashier.cashierBarcode || '').trim()
    if (!code) {
      flash(`This ${staffNoun.toLowerCase()} does not have a barcode yet.`)
      return
    }

    const label = {
        title: cashier.name || staffNoun,
        value: code,
        meta: [cashier.cashierId || cashier.id, isManagerTab ? 'Manager approval' : cashier.shift].filter(Boolean).join(' | '),
    }

    // A row action labelled Print should submit the job immediately. The old
    // flow only opened a second preview, which made manager labels appear to do
    // nothing until another Print button was found and clicked.
    setPrintingBarcode(cashier.id)
    try {
      const result = await printBarcodeLabels(label, {
        ...cashierPrintSettings(),
        documentName: `${staffNoun} Barcode ${cashier.name || code}`,
      })
      if (result?.path) {
        flash(`${staffNoun} barcode PDF saved to ${result.path}.`)
      } else {
        flash(`Sent ${Number(result?.copies) || printSettings.copies} ${staffNoun.toLowerCase()} barcode label(s) to ${result?.printerName || 'printer'}.`)
      }
    } catch (err) {
      flash(err.message || `Unable to print ${staffNoun.toLowerCase()} barcode.`)
    } finally {
      setPrintingBarcode('')
    }
  }

  async function printSelectedCashiers() {
    openBarcodePreview(selectedCashierBarcodes, `${staffNoun} Barcodes (${selectedCashierBarcodes.length})`)
  }

  async function printPreviewedBarcodes() {
    if (!barcodePreview?.labels?.length) return
    setPrintingBarcode('preview')
    try {
      const result = await printBarcodeLabels(barcodePreview.labels, {
        ...cashierPrintSettings(),
        documentName: barcodePreview.documentName,
      })
      const copies = Number(result?.copies) || (barcodePreview.labels.length * printSettings.copies)
      if (result?.path) {
        flash(`${staffNoun} barcode PDF saved to ${result.path}.`)
      } else {
        flash(`Sent ${copies} ${staffNoun.toLowerCase()} barcode label${copies === 1 ? '' : 's'} to ${result?.printerName || 'printer'}.`)
      }
    } catch (err) {
      flash(err.message || `Unable to print ${staffNoun.toLowerCase()} barcode labels.`)
    } finally {
      setPrintingBarcode('')
    }
  }

  async function savePreviewedBarcodes() {
    if (!barcodePreview?.labels?.length) return
    setPrintingBarcode('save-preview')
    try {
      const path = await saveBarcodeLabelsPdf(barcodePreview.labels, {
        ...printSettings,
        documentName: barcodePreview.documentName,
      })
      flash(path ? `${staffNoun} barcode PDF saved to ${path}.` : `${staffNoun} barcode PDF save cancelled.`)
    } catch (err) {
      flash(err.message || `Unable to save ${staffNoun.toLowerCase()} barcode PDF.`)
    } finally {
      setPrintingBarcode('')
    }
  }

  const previewLabels = useMemo(() => {
    if (!barcodePreview?.labels?.length) return []
    const copies = Math.min(99, Math.max(1, Number(printSettings.copies) || 1))
    return barcodePreview.labels.flatMap((label) => Array.from({ length: copies }, () => label))
  }, [barcodePreview, printSettings.copies])

  if (loading) {
    return <PageLoader title="Staff Management" message={`Loading ${staffNoun.toLowerCase()} accounts…`} />
  }

  if (error) {
    return (
      <>
        <PageHeader title="Staff Management" subtitle="Manage cashier and manager accounts, barcodes, and access." />
        <div className="card"><div className="empty"><h4>{`Unable to load ${staffNounPlural.toLowerCase()}`}</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Staff Management"
        subtitle="Manage cashier and manager accounts, barcodes, and access."
      >
        <label className="barcode-print-count barcode-printer-select">
          <span>Printer</span>
          <select
            className="select"
            value={printSettings.printerName || BROWSER_PRINT_VALUE}
            onChange={(e) => updatePrintSettings({ printerName: e.target.value })}
            aria-label={`${staffNoun} barcode printer`}
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
            onChange={(e) => updatePrintSettings({ copies: e.target.value === '' ? '' : Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
            onBlur={(e) => updatePrintSettings({ copies: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
            aria-label={`${staffNoun} barcode labels to print`}
          />
        </label>
        <button
          className="btn btn-outline barcode-folder-button"
          onClick={chooseBarcodeFolder}
          title={printSettings.pdfDirectory || `Choose folder for saved ${staffNoun.toLowerCase()} barcode PDFs`}
        >
          <IconDownload size={16} /> Folder
        </button>
        <button className="btn btn-outline" onClick={toggleAllCashiers} disabled={printableCashiers.length === 0}>
          {allPrintableSelected ? 'Clear Selection' : 'Select All'}
        </button>
        <button className="btn btn-primary" onClick={printSelectedCashiers} disabled={selectedCashierBarcodes.length === 0 || printingBarcode === 'selected'}>
          {printingBarcode === 'selected' ? 'Printing...' : `Print Selected (${selectedCashierBarcodes.length})`}
        </button>
        <button className="btn btn-outline" onClick={() => dialog.alert(`Scan a ${staffNoun.toLowerCase()} ID badge to look up an account.`, { title: `${staffNoun} lookup` })}>
          <IconScan size={16} /> Scan ID
        </button>
        <button className="btn btn-primary" onClick={openAddCashier}>
          <IconUserPlus size={16} /> Add {staffNoun}
        </button>
      </PageHeader>

      <div className="scan-mode-row analytics-tabs staff-tabs" role="tablist" aria-label="Staff sections">
        <button
          type="button"
          className={`scan-mode ${activeTab === 'cashier' ? 'active' : ''}`}
          onClick={() => switchStaffTab('cashier')}
          role="tab"
          aria-selected={activeTab === 'cashier'}
        >
          Cashiers
        </button>
        <button
          type="button"
          className={`scan-mode ${activeTab === 'manager' ? 'active' : ''}`}
          onClick={() => switchStaffTab('manager')}
          role="tab"
          aria-selected={activeTab === 'manager'}
        >
          Managers
        </button>
      </div>

      <div className="stat-grid cols-3">
        <StatCard label={`Total ${staffNounPlural}`} tone="indigo" icon={IconUsers} value={list.length} foot="registered accounts" />
        <StatCard label="Active" tone="green" icon={IconUsers} value={active} foot="currently enabled" />
        <StatCard label="Inactive" tone="amber" icon={IconUsers} value={list.length - active} foot="disabled accounts" />
      </div>

      <div className="card">
        <div className="panel-head">
          <h3>{staffNoun} Accounts</h3>
          <span className="sub">{list.length} total</span>
        </div>

        {list.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconUsers size={26} /></div>
            <h4>No {staffNounPlural.toLowerCase()} added yet</h4>
            <p>Click the button below to register your first {staffNoun.toLowerCase()}.</p>
            <button className="btn btn-primary" onClick={openAddCashier}>
              <IconUserPlus size={16} /> Add {staffNoun}
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="t-center">
                    <input
                      type="checkbox"
                      checked={allPrintableSelected}
                      ref={(node) => {
                        if (node) node.indeterminate = somePrintableSelected && !allPrintableSelected
                      }}
                      onChange={toggleAllCashiers}
                      disabled={printableCashiers.length === 0}
                      aria-label={`Select all ${staffNoun.toLowerCase()} barcodes`}
                    />
                  </th>
                  <th>{staffNoun}</th>
                  <th>{staffNoun} ID</th>
                  <th>{isManagerTab ? 'Approval Barcode' : 'Login Barcode'}</th>
                  {!isManagerTab && <th>Shift</th>}
                  {!isManagerTab && <th>Total Sales</th>}
                  <th className="t-center cashier-status-col">Status</th>
                  <th className="t-center cashier-actions-col">Actions</th>
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
                    {!isManagerTab && <td>{c.shift}</td>}
                    {!isManagerTab && <td>{peso(c.sales)}</td>}
                    <td className="t-center cashier-status-col">
                      <span className={'badge ' + (c.status === 'active' ? 'badge-success' : 'badge-neutral')}>
                        {c.status === 'active' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="t-center cashier-actions-col">
                      <div className="row-actions cashier-row-actions">
                        <button className="icon-btn" title="Edit" onClick={() => openEditCashier(c)}>
                          <IconEdit size={15} />
                        </button>
                        <button
                          className="btn btn-outline cashier-print-btn"
                          title={`Print ${staffNoun.toLowerCase()} barcode`}
                          onClick={() => printCashierBarcode(c)}
                          disabled={printingBarcode === c.id}
                        >
                          <IconScan size={15} /> {printingBarcode === c.id ? 'Printing...' : 'Print'}
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
          title={isEdit ? `Edit ${staffNoun}` : `Add ${staffNoun}`}
          onClose={closeModal}
          footer={
            <>
              <button className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={saveCashier} disabled={saving}>
                {saving ? 'Saving...' : isEdit ? 'Save Changes' : `Add ${staffNoun}`}
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
                    <img src={imagePreview} alt={`${form.name || staffNoun} profile preview`} />
                    <span>Click to replace profile picture</span>
                  </>
                ) : (
                  <>
                    <div className="di"><IconImage size={20} /></div>
                    Click to upload {staffNoun.toLowerCase()} profile picture
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
              <label>{isManagerTab ? 'Manager Approval Barcode' : 'Cashier Login Barcode'}</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <input
                  className="input"
                  placeholder={`Scan or generate ${staffNoun.toLowerCase()} barcode`}
                  value={form.cashierBarcode || ''}
                  onChange={set('cashierBarcode')}
                />
                <button type="button" className="btn btn-outline" onClick={() => setForm((current) => ({ ...current, cashierBarcode: nextStaffBarcode(activeTab) }))}>
                  Generate
                </button>
              </div>
            </div>
            {!isManagerTab && (
              <div className="field">
                <label>Shift</label>
                <select className="select" value={form.shift} onChange={set('shift')}>
                  {['Morning', 'Afternoon', 'Evening'].map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label>Status</label>
              <select className="select" value={form.status} onChange={set('status')}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            {!isManagerTab && (
              <fieldset className="permission-grid span-2">
                <legend>POS Permissions</legend>
                <p>Manager approval is still required for protected actions.</p>
                <div>{cashierCapabilities.map(([value, label]) => (
                  <label key={value}><input type="checkbox" checked={form.permissions.includes(value)} onChange={() => togglePermission(value)} /><span>{label}</span></label>
                ))}</div>
              </fieldset>
            )}
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

      {barcodePreview && (
        <Modal
          title={`${staffNoun} Barcode Preview`}
          onClose={() => setBarcodePreview(null)}
          footer={
            <>
              <button
                className="btn btn-outline"
                onClick={() => setBarcodePreview(null)}
                disabled={printingBarcode === 'preview' || printingBarcode === 'save-preview'}
              >
                Close
              </button>
              <button
                className="btn btn-outline"
                onClick={savePreviewedBarcodes}
                disabled={printingBarcode === 'preview' || printingBarcode === 'save-preview'}
              >
                <IconDownload size={16} /> {printingBarcode === 'save-preview' ? 'Saving...' : 'Save PDF'}
              </button>
              <button
                className="btn btn-primary"
                onClick={printPreviewedBarcodes}
                disabled={printingBarcode === 'preview' || printingBarcode === 'save-preview'}
              >
                <IconScan size={16} /> {printingBarcode === 'preview' ? 'Printing...' : 'Print'}
              </button>
            </>
          }
        >
          <div className="barcode-preview-modal">
            <div className="barcode-preview-summary">
              <strong>{barcodePreview.documentName}</strong>
              <span>{previewLabels.length} label{previewLabels.length === 1 ? '' : 's'} total</span>
              <small>{printSettings.pdfDirectory ? `Save folder: ${printSettings.pdfDirectory}` : 'Choose a folder to save PDFs without a file picker.'}</small>
            </div>
            <div className="barcode-preview-sheet">
              {previewLabels.map((label, index) => (
                <div className="barcode-preview-label" key={`${label.id || label.value}-${index}`}>
                  <strong>{label.title || staffNoun}</strong>
                  {label.meta ? <span>{label.meta}</span> : null}
                  <div
                    className="barcode-preview-svg"
                    dangerouslySetInnerHTML={{ __html: barcodeSvg(label.value) }}
                  />
                  <code>{label.value}</code>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconUserPlus size={15} /> {toast}</div>}
    </>
  )
}
