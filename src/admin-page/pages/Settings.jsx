import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import { IconDownload, IconSettings, IconUsers } from '../components/Icons'
import { api } from '../services/api'
import { useApi } from '../hooks/useApi'
import {
  exportLocationKeys,
  exportLocationLabels,
  getExportLocations,
  saveExportLocations,
} from '../utils/exportSettings'
import {
  saveBarcodePrintSettings,
  savedBarcodePrintSettings,
  selectBarcodePdfDirectory,
} from '../utils/barcodePrinter'
import { getStoredTheme, saveTheme, THEMES } from '../../utils/themeSettings'

export default function Settings() {
  const {
    data: admins,
    setData: setAdmins,
    loading: adminsLoading,
    error: adminsError,
  } = useApi(api.settingsAdmins, [])
  const { data: cashiers, setData: setCashiers, loading, error } = useApi(api.settingsCashiers, [])
  const [toast, setToast] = useState('')
  const [exportLocations, setExportLocations] = useState(getExportLocations)
  const [barcodePrintSettings, setBarcodePrintSettings] = useState(savedBarcodePrintSettings)
  const [theme, setTheme] = useState(getStoredTheme)

  function flash(message) {
    setToast(message)
    setTimeout(() => setToast(''), 2400)
  }

  async function toggleQuickLogin(cashier) {
    const enabled = !cashier.quickLoginEnabled
    try {
      const updated = await api.updateCashierQuickLogin(cashier.id, enabled)
      setCashiers(cashiers.map((item) => (item.id === cashier.id ? updated : item)))
      flash(`${enabled ? 'Enabled' : 'Disabled'} quick login for ${cashier.name}.`)
    } catch (err) {
      flash(err.message || 'Unable to update quick login.')
    }
  }

  async function toggleAdminQuickLogin(admin) {
    const enabled = !admin.quickLoginEnabled
    try {
      const updated = await api.updateAdminQuickLogin(admin.id, enabled)
      setAdmins(admins.map((item) => (item.id === admin.id ? updated : item)))
      flash(`${enabled ? 'Enabled' : 'Disabled'} quick login for ${admin.name}.`)
    } catch (err) {
      flash(err.message || 'Unable to update admin quick login.')
    }
  }

  function updateExportLocation(type, value) {
    const saved = saveExportLocations({ ...exportLocations, [type]: value })
    setExportLocations(saved)
  }

  function updateBarcodeLocation(value) {
    const saved = saveBarcodePrintSettings({ ...barcodePrintSettings, pdfDirectory: value })
    setBarcodePrintSettings(saved)
  }

  function updateTheme(enabled) {
    const nextTheme = saveTheme(enabled ? THEMES.dark : THEMES.light)
    setTheme(nextTheme)
    flash(`${nextTheme === THEMES.dark ? 'Dark' : 'Light'} mode enabled.`)
  }

  async function chooseExportFolder(type) {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
    if (!invoke) {
      flash('Folder picker is available in the desktop app.')
      return
    }

    try {
      const selected = await invoke('select_export_folder')
      if (!selected) return
      updateExportLocation(type, selected)
      flash(`${exportLocationLabels[type]} export location saved.`)
    } catch (err) {
      flash(err.message || 'Unable to open folder picker.')
    }
  }

  async function chooseBarcodeFolder() {
    try {
      const selected = await selectBarcodePdfDirectory()
      if (!selected) return
      updateBarcodeLocation(selected)
      flash('Cashier Barcodes export location saved.')
    } catch (err) {
      flash(err.message || 'Unable to open folder picker.')
    }
  }

  if (loading || adminsLoading) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Loading account settings..." />
        <div className="card"><div className="empty"><h4>Loading settings</h4></div></div>
      </>
    )
  }

  if (error || adminsError) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Configure cashier access and POS behavior." />
        <div className="card"><div className="empty"><h4>Unable to load settings</h4><p>{error || adminsError}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Configure cashier access, quick login, and account behavior."
      />

      <div className="grid-gap">
        <div className="card">
          <div className="panel-head">
            <div>
              <h3>Appearance</h3>
              <span className="sub">Use dark mode across the admin and cashier screens on this device.</span>
            </div>
            <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
          </div>

          <div className="panel-body">
            <label className="settings-toggle-card">
              <input
                type="checkbox"
                checked={theme === THEMES.dark}
                onChange={(event) => updateTheme(event.target.checked)}
              />
              <span>
                <strong>Dark mode</strong>
                <small>Applies to the whole POS system on this computer.</small>
              </span>
            </label>
          </div>
        </div>

        <div className="card">
          <div className="panel-head">
            <div>
              <h3>Export Locations</h3>
              <span className="sub">Set where desktop exports are saved on this device.</span>
            </div>
            <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
          </div>

          <div className="panel-body export-settings-grid">
            {Object.values(exportLocationKeys).map((key) => (
              <label className="field" key={key}>
                <span>{exportLocationLabels[key]}</span>
                <div className="folder-picker-row">
                  <input
                    className="input"
                    value={exportLocations[key]}
                    placeholder="Example: C:\\Users\\Public\\Documents\\Nexa POS Exports"
                    onChange={(event) => updateExportLocation(key, event.target.value)}
                    onBlur={() => flash(`${exportLocationLabels[key]} export location saved.`)}
                  />
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => chooseExportFolder(key)}
                  >
                    <IconDownload size={16} /> Choose Folder
                  </button>
                </div>
              </label>
            ))}
            <label className="field">
              <span>Cashier Barcodes</span>
              <div className="folder-picker-row">
                <input
                  className="input"
                  value={barcodePrintSettings.pdfDirectory}
                  placeholder="Example: C:\\Users\\Public\\Documents\\Nexa POS Exports"
                  onChange={(event) => updateBarcodeLocation(event.target.value)}
                  onBlur={() => flash('Cashier Barcodes export location saved.')}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={chooseBarcodeFolder}
                >
                  <IconDownload size={16} /> Choose Folder
                </button>
              </div>
            </label>
          </div>
        </div>

        <div className="card">
          <div className="panel-head">
            <div>
              <h3>Admin Quick Login</h3>
              <span className="sub">Show selected admin accounts on the admin login screen. Password is still required.</span>
            </div>
            <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
          </div>

          {admins.length === 0 ? (
            <div className="empty">
              <div className="em-icon"><IconUsers size={24} /></div>
              <h4>No admin accounts</h4>
              <p>Create admin accounts before enabling quick login.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Admin</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th className="t-center">Quick Login</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.map((admin) => (
                    <tr key={admin.id}>
                      <td>
                        <div className="prod-cell">
                          <div className="user-chip" style={{ border: 'none', padding: 0 }}>
                            <div className="av">{admin.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</div>
                          </div>
                          <div>
                            <div className="prod-name">{admin.name}</div>
                            <div className="prod-id">{admin.id}</div>
                          </div>
                        </div>
                      </td>
                      <td>{admin.email}</td>
                      <td>
                        <span className={'badge ' + (admin.status === 'active' ? 'badge-success' : 'badge-neutral')}>
                          {admin.status === 'active' ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="t-center">
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={admin.quickLoginEnabled}
                            onChange={() => toggleAdminQuickLogin(admin)}
                            disabled={admin.status !== 'active'}
                          />
                          <span />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="panel-head">
            <div>
              <h3>Cashier Quick Login</h3>
              <span className="sub">Show selected cashier accounts on the cashier login screen. Password is still required.</span>
            </div>
            <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
          </div>

          {cashiers.length === 0 ? (
            <div className="empty">
              <div className="em-icon"><IconUsers size={24} /></div>
              <h4>No cashier accounts</h4>
              <p>Create cashier accounts before enabling quick login.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Cashier</th>
                    <th>Email</th>
                    <th>Shift</th>
                    <th>Status</th>
                    <th className="t-center">Quick Login</th>
                  </tr>
                </thead>
                <tbody>
                  {cashiers.map((cashier) => (
                    <tr key={cashier.id}>
                      <td>
                        <div className="prod-cell">
                          <div className="user-chip" style={{ border: 'none', padding: 0 }}>
                            <div className="av">{cashier.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</div>
                          </div>
                          <div>
                            <div className="prod-name">{cashier.name}</div>
                            <div className="prod-id">{cashier.cashierId}</div>
                          </div>
                        </div>
                      </td>
                      <td>{cashier.email}</td>
                      <td>{cashier.shift}</td>
                      <td>
                        <span className={'badge ' + (cashier.status === 'active' ? 'badge-success' : 'badge-neutral')}>
                          {cashier.status === 'active' ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="t-center">
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={cashier.quickLoginEnabled}
                            onChange={() => toggleQuickLogin(cashier)}
                            disabled={cashier.status !== 'active'}
                          />
                          <span />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {toast && <div className="toast"><IconSettings size={15} /> {toast}</div>}
    </>
  )
}
