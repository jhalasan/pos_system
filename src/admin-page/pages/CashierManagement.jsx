import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { IconUsers, IconUserPlus, IconScan, IconTrash, IconEdit } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

const blank = { name: '', email: '', shift: 'Morning', status: 'active' }

export default function CashierManagement() {
  const { data: list, setData: setList, loading, error } = useApi(api.cashiers, [])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(blank)
  const [toast, setToast] = useState('')

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  async function addCashier() {
    if (!form.name.trim() || !form.email.trim()) {
      alert('Name and email are required.')
      return
    }

    try {
      const created = await api.createCashier(form)
      setList([...list, created])
      setForm(blank)
      setOpen(false)
      flash('Cashier added.')
    } catch (err) {
      flash(err.message || 'Unable to add cashier.')
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
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
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
            <button className="btn btn-primary" onClick={() => setOpen(true)}>
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
                          <div className="av">{c.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</div>
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
                        <button className="icon-btn" title="Edit" onClick={() => alert('Edit cashier form will use the API next.')}>
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
          title="Add Cashier"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addCashier}>Add Cashier</button>
            </>
          }
        >
          <div className="form-grid">
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
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconUserPlus size={15} /> {toast}</div>}
    </>
  )
}
