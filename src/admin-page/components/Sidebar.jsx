import { NavLink, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { logout } from '../auth'
import { api } from '../services/api'
import Modal from './Modal'
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
  const [syncQueue, setSyncQueue] = useState([])
  const [showSyncCenter, setShowSyncCenter] = useState(false)
  const [selectedConflict, setSelectedConflict] = useState(null)
  const [fieldChoices, setFieldChoices] = useState({})

  useEffect(() => {
    if (!showSyncCenter) return undefined

    let active = true
    const refreshQueue = async () => {
      const queue = await api.syncQueueDetails().catch(() => null)
      if (active && queue) setSyncQueue(queue)
    }
    const handleSyncStatus = (event) => {
      const state = event.detail?.state
      if (state === 'succeeded' || state === 'failed' || state === 'offline') {
        void refreshQueue()
      }
    }

    void refreshQueue()
    globalThis.addEventListener?.('nexa-sync-status', handleSyncStatus)
    // Also cover queue changes made in another window/runtime that do not
    // dispatch an event into this React document.
    const intervalId = globalThis.setInterval?.(refreshQueue, 2000)
    return () => {
      active = false
      globalThis.removeEventListener?.('nexa-sync-status', handleSyncStatus)
      if (intervalId) globalThis.clearInterval?.(intervalId)
    }
  }, [showSyncCenter])

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
      setSyncQueue(await api.syncQueueDetails())
      setShowSyncCenter(true)
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

  async function resolveConflict(op, resolution, fields = {}) {
    try {
      await api.resolveSyncConflict(op.id, resolution, fields)
      setSyncQueue(await api.syncQueueDetails())
      setSelectedConflict(null)
      flash(`Conflict resolved using ${resolution === 'fields' ? 'selected fields' : resolution}.`)
    } catch (error) {
      flash(error.message || 'Unable to resolve conflict.')
    }
  }

  function reviewFields(op) {
    setSelectedConflict(op)
    setFieldChoices(Object.fromEntries((op.conflict?.fields || []).map((field) => [field, 'local'])))
  }

  function displayValue(value) {
    if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value)
    return value === '' || value === null || value === undefined ? '—' : String(value)
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
      {showSyncCenter && (
        <Modal className="sync-center-modal" title="Sync Conflict Center" onClose={() => { setShowSyncCenter(false); setSelectedConflict(null) }}>
          <div className="sync-center-summary">
            <div><strong>{syncQueue.filter((op) => op.status === 'pending').length}</strong><span>Waiting</span></div>
            <div><strong>{syncQueue.filter((op) => op.status === 'failed').length}</strong><span>Failed</span></div>
            <div><strong>{syncQueue.filter((op) => op.status === 'conflict').length}</strong><span>Conflicts</span></div>
          </div>
          {selectedConflict ? (
            <div className="sync-conflict-review">
              <button className="btn btn-outline btn-sm" onClick={() => setSelectedConflict(null)}>Back</button>
              <h4>Review {selectedConflict.conflict?.local?.name || 'Product'} field by field</h4>
              {(selectedConflict.conflict?.fields || []).map((field) => (
                <div className="sync-field-row" key={field}>
                  <strong>{field}</strong>
                  <label><input type="radio" name={`field-${field}`} checked={fieldChoices[field] === 'local'} onChange={() => setFieldChoices((current) => ({ ...current, [field]: 'local' }))} /> Local: {displayValue(selectedConflict.conflict.local?.[field])}</label>
                  <label><input type="radio" name={`field-${field}`} checked={fieldChoices[field] === 'cloud'} onChange={() => setFieldChoices((current) => ({ ...current, [field]: 'cloud' }))} /> Cloud: {displayValue(selectedConflict.conflict.cloud?.[field])}</label>
                </div>
              ))}
              <button className="btn btn-primary" onClick={() => resolveConflict(selectedConflict, 'fields', Object.fromEntries(Object.entries(fieldChoices).map(([field, source]) => [field, selectedConflict.conflict[source]?.[field]])))}>Apply Selected Fields</button>
            </div>
          ) : syncQueue.length === 0 ? (
            <div className="empty"><h4>Everything is synchronized</h4><p>No pending, failed, or conflicting changes.</p></div>
          ) : (
            <div className="sync-queue-list">
              {syncQueue.map((op) => (
                <div className={`sync-queue-card ${op.status}`} key={op.id}>
                  <div><strong>{op.payload?.name || op.transactionNo || op.payload?.barcode || op.type}</strong><small>{op.source || 'Admin'} · {op.type} · {op.status}</small>{op.lastError && <p>{op.lastError}</p>}</div>
                  {op.status === 'conflict' && <div className="sync-conflict-actions"><button className="btn btn-outline btn-sm" onClick={() => resolveConflict(op, 'cloud')}>Use Cloud</button><button className="btn btn-outline btn-sm" onClick={() => reviewFields(op)}>Review Fields</button><button className="btn btn-primary btn-sm" onClick={() => resolveConflict(op, 'local')}>Use Local</button></div>}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </aside>
  )
}
