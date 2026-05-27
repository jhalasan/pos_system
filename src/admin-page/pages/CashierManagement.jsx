import { useEffect, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { IconUsers, IconUserPlus, IconScan, IconTrash, IconEdit, IconImage } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

const blank = { name: '', email: '', shift: 'Morning', status: 'active', password: '', passwordConfirm: '' }

export default function CashierManagement() {
  const { data: list, setData: setList, loading, error } = useApi(api.cashiers, [])
  const [open, setOpen] = useState(false)
  const [editingCashier, setEditingCashier] = useState(null)
  const [form, setForm] = useState(blank)
  const [imagePreview, setImagePreview] = useState('')
  const fileInputRef = useRef(null)
  const objectUrlRef = useRef('')
  const [toast, setToast] = useState('')
  const isEdit = Boolean(editingCashier)

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  function openAddCashier() {
    setEditingCashier(null)
    setForm(blank)
    setImagePreview('')
    setOpen(true)
  }

  function openEditCashier(cashier) {
    setEditingCashier(cashier)
    setForm({
      name: cashier.name || '',
      email: cashier.email || '',
      shift: cashier.shift || 'Morning',
      status: cashier.status || 'active',
      password: '',
      passwordConfirm: '',
    })
    setImagePreview(cashier.imageUrl || '')
    setOpen(true)
  }

  function closeModal() {
    setOpen(false)
    setEditingCashier(null)
    setForm(blank)
    setImagePreview('')
  }

  function selectImage(file) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      alert('Please upload a JPEG, PNG, or WEBP image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Profile image must be 5MB or smaller.')
      return
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = URL.createObjectURL(file)
    setImagePreview(objectUrlRef.current)
    setForm((current) => ({ ...current, imageFile: file }))
  }

  async function saveCashier() {
    if (!form.name.trim() || !form.email.trim()) {
      alert('Name and email are required.')
      return
    }

    if (!isEdit && !form.password.trim()) {
      alert('Password is required for new cashiers.')
      return
    }

    if (form.password || form.passwordConfirm) {
      if (form.password.length < 8) {
        alert('Password must be at least 8 characters.')
        return
      }
      if (form.password !== form.passwordConfirm) {
        alert('Passwords do not match.')
        return
      }
    }

    try {
      if (isEdit) {
        const updated = await api.updateCashier(editingCashier.id, form)
        setList(list.map((item) => (item.id === updated.id ? updated : item)))
        flash('Cashier updated.')
      } else {
        const created = await api.createCashier(form)
        setList([...list, created])
        flash('Cashier added.')
      }
      closeModal()
    } catch (err) {
      flash(err.message || 'Unable to save cashier.')
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
                  <th>Cashier</th>
                  <th>Cashier ID</th>
                  <th>Shift</th>
                  <th>Total Sales</th>
                  <th>Status</th>
                  <th className="t-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
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
              <button className="btn btn-outline" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={saveCashier}>
                {isEdit ? 'Save Changes' : 'Add Cashier'}
              </button>
            </>
          }
        >
          <div className="form-grid">
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
              <input className="input" type="email" placeholder="name@example.com" value={form.email} onChange={set('email')} />
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
            <div className="field">
              <label>{isEdit ? 'New Password' : 'Password'}</label>
              <input
                className="input"
                type="password"
                placeholder={isEdit ? 'Leave blank to keep current' : 'At least 8 characters'}
                value={form.password}
                onChange={set('password')}
              />
            </div>
            <div className="field">
              <label>Confirm Password</label>
              <input
                className="input"
                type="password"
                placeholder={isEdit ? 'Confirm new password' : 'Repeat password'}
                value={form.passwordConfirm}
                onChange={set('passwordConfirm')}
              />
            </div>
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconUserPlus size={15} /> {toast}</div>}
    </>
  )
}
