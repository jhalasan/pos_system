import { NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { logout } from '../auth'
import { api } from '../services/api'
import { getTerminalName, setTerminalName } from '../../utils/terminalIdentity'
import {
  IconDashboard, IconBox, IconTag, IconUsers, IconChart, IconList,
  IconCloud, IconLogout, IconSettings, IconBarcode,
  IconReceipt,
} from './Icons'

const navItems = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: IconDashboard },
  { to: '/admin/inventory', label: 'Inventory', icon: IconBox },
  { to: '/admin/products', label: 'Product Management', icon: IconTag },
  { to: '/admin/barcodes', label: 'Barcode Tools', icon: IconBarcode },
  { to: '/admin/cashiers', label: 'Staff Management', icon: IconUsers },
  { to: '/admin/analytics', label: 'Analytics', icon: IconChart },
  { to: '/admin/transaction-logs', label: 'Transaction Logs', icon: IconReceipt },
  { to: '/admin/audit', label: 'Audit', icon: IconList },
  { to: '/admin/logs', label: 'Activity Logs', icon: IconList },
]

export default function Sidebar({ open = false, collapsed = false, onNavigate = () => {} }) {
  const nav = useNavigate()
  const [toast, setToast] = useState('')
  const [terminalName, updateTerminalName] = useState(getTerminalName)

  function handleLogout() {
    logout()
    nav('/', { replace: true })
  }

  function flash(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function handleSync() {
    try {
      const result = await api.syncNow()
      if ((result.uploaded || 0) === 0 && (result.failed || 0) === 0) {
        flash(`Cloud sync complete. ${result.pending || 0} pending.`)
      } else if ((result.failed || 0) > 0 && result.errors?.[0]) {
        flash(`Cloud sync failed: ${result.errors[0]}`)
      } else {
        flash(`Cloud sync complete. Uploaded ${result.uploaded || 0}, failed ${result.failed || 0}.`)
      }
    } catch (error) {
      flash(error.message || 'Unable to sync right now.')
    }
  }

  function renameTerminal() {
    const value = prompt('Terminal name (for example COUNTER-A):', terminalName)
    if (value === null) return
    updateTerminalName(setTerminalName(value))
  }

  return (
    <aside className={'sidebar' + (open ? ' active' : '') + (collapsed ? ' collapsed' : '')}>
      <div className="sidebar-brand">
        <div className="mk">N</div>
        <div>
          <div className="nm">NEXA POS</div>
          <div className="sb">Admin Control Panel</div>
          <button type="button" className="terminal-name" onClick={renameTerminal} title="Rename this terminal">
            {terminalName}
          </button>
        </div>
      </div>

      <nav className="nav-section">
        <div className="nav-label">Main Menu</div>
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            onClick={onNavigate}
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <Icon size={18} />
            <span className="nav-text">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className="nav-item"
          style={{ width: '100%' }}
          title={collapsed ? 'Sync to Cloud' : undefined}
          onClick={handleSync}
        >
          <IconCloud size={18} />
          <span className="nav-text">Sync to Cloud</span>
        </button>
        <NavLink to="/admin/settings" className="nav-item" onClick={onNavigate} title={collapsed ? 'Settings' : undefined}>
          <IconSettings size={18} />
          <span className="nav-text">Settings</span>
        </NavLink>
        <button className="nav-item danger" style={{ width: '100%' }} onClick={handleLogout} title={collapsed ? 'Logout' : undefined}>
          <IconLogout size={18} />
          <span className="nav-text">Logout</span>
        </button>
      </div>

      {toast && <div className="toast"><IconCloud size={15} /> {toast}</div>}
    </aside>
  )
}
