import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import Modal from '../components/Modal'
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
import { getDeveloperModeSettings, isDeveloperPinValid, saveDeveloperModeSettings } from '../../utils/developerMode'

const emptyReadiness = { ready: false, products: 0, categories: 0, users: 0, authorizationBarcodes: 0, managerApprovals: 0, offlineCashierLogins: 0, receipts: 0, pending: 0, failed: 0 }

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
  const [developerModeSettings, setDeveloperModeSettings] = useState(getDeveloperModeSettings)
  const [developerPinInput, setDeveloperPinInput] = useState('')
  const [developerPinModalOpen, setDeveloperPinModalOpen] = useState(false)
  const [developerPinError, setDeveloperPinError] = useState('')
  const [activeTab, setActiveTab] = useState('general')
  const { data: readiness, setData: setReadiness, loading: readinessLoading } = useApi(api.offlineReadiness, emptyReadiness)
  const [downloadingOfflineData, setDownloadingOfflineData] = useState(false)

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

  function updateDeveloperModeSettings(patch) {
    if (patch.enabled === true) {
      if (!isDeveloperPinValid(developerPinInput, developerModeSettings)) {
        flash('Incorrect developer PIN.')
        return developerModeSettings
      }
    }

    const nextSettings = saveDeveloperModeSettings(patch)
    setDeveloperModeSettings(nextSettings)
    return nextSettings
  }

  function closeDeveloperPinModal() {
    setDeveloperPinModalOpen(false)
    setDeveloperPinInput('')
    setDeveloperPinError('')
  }

  function requestDeveloperModeChange(enabled) {
    if (!enabled) {
      updateDeveloperModeSettings({ enabled: false })
      return
    }

    setDeveloperPinInput('')
    setDeveloperPinError('')
    setDeveloperPinModalOpen(true)
  }

  function confirmDeveloperMode(event) {
    event.preventDefault()
    if (!isDeveloperPinValid(developerPinInput, developerModeSettings)) {
      setDeveloperPinError('Incorrect developer PIN. Please try again.')
      return
    }

    const nextSettings = saveDeveloperModeSettings({ enabled: true })
    setDeveloperModeSettings(nextSettings)
    closeDeveloperPinModal()
    flash('Developer mode enabled.')
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

  async function downloadOfflineData() {
    setDownloadingOfflineData(true)
    try {
      const result = await api.downloadOfflineData()
      setReadiness(result)
      flash(result.ready ? 'Offline data is ready on this terminal.' : 'Download finished, but some offline requirements are still incomplete.')
    } catch (err) {
      flash(err.message || 'Unable to download offline data.')
    } finally {
      setDownloadingOfflineData(false)
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

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Configure cashier access, quick login, and account behavior."
      />

      <div className="staff-tabs settings-tabs">
        <button className={activeTab === 'general' ? 'active' : ''} onClick={() => setActiveTab('general')}>General</button>
        <button className={activeTab === 'developer' ? 'active' : ''} onClick={() => setActiveTab('developer')}>Developer Mode</button>
        <button className={activeTab === 'offline' ? 'active' : ''} onClick={() => setActiveTab('offline')}>Offline Readiness</button>
      </div>

      {activeTab === 'general' ? <div className="grid-gap">
        {(error || adminsError) && (
          <div className="alert error">Staff account settings could not be loaded: {error || adminsError}. Local appearance and export settings remain available.</div>
        )}
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
      </div> : activeTab === 'developer' ? (
        <div className="grid-gap">
          <div className={`card developer-mode-card${developerModeSettings.enabled ? ' enabled' : ''}`}>
            <div className="panel-head">
              <div>
                <h3>Developer Mode</h3>
                <span className="sub">Toggle developer-only cashier behavior and configure a special developer barcode.</span>
              </div>
              {developerModeSettings.enabled
                ? <span className="developer-mode-status">Developer Mode Enabled</span>
                : <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>}
            </div>

            <div className="panel-body">
              <label className="settings-toggle-card">
                <input
                  type="checkbox"
                  checked={developerModeSettings.enabled}
                  onChange={(event) => requestDeveloperModeChange(event.target.checked)}
                />
                <span>
                  <strong>Enable developer mode</strong>
                  <small>Turns on the developer-only behavior below for this device.</small>
                </span>
              </label>
            </div>
          </div>

          <div className="card">
            <div className="panel-head">
              <div>
                <h3>Developer Behaviors</h3>
                <span className="sub">Control which cashier actions become required when developer mode is enabled.</span>
              </div>
              <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
            </div>

            <div className="panel-body">
              <label className="settings-toggle-card">
                <input
                  type="checkbox"
                  checked={Boolean(developerModeSettings.requireCashDrawer)}
                  onChange={(event) => updateDeveloperModeSettings({ requireCashDrawer: event.target.checked })}
                  disabled={!developerModeSettings.enabled}
                />
                <span>
                  <strong>Require cash drawer opening</strong>
                  <small>Requires the drawer to be opened and closed before the receipt print step continues.</small>
                </span>
              </label>

              <label className="settings-toggle-card">
                <input
                  type="checkbox"
                  checked={Boolean(developerModeSettings.requireReceiptPrint)}
                  onChange={(event) => updateDeveloperModeSettings({ requireReceiptPrint: event.target.checked })}
                  disabled={!developerModeSettings.enabled}
                />
                <span>
                  <strong>Require receipt printing</strong>
                  <small>Blocks the final receipt step until a receipt print succeeds when enabled.</small>
                </span>
              </label>
            </div>
          </div>

          <div className="card">
            <div className="panel-head">
              <div>
                <h3>Developer Barcode</h3>
                <span className="sub">Set a special barcode and PIN for developer access on this device.</span>
              </div>
              <span className="stat-icon ic-indigo"><IconSettings size={18} /></span>
            </div>

            <div className="panel-body">
              <label className="settings-toggle-card">
                <input
                  type="checkbox"
                  checked={Boolean(developerModeSettings.developerBarcodeEnabled)}
                  onChange={(event) => updateDeveloperModeSettings({ developerBarcodeEnabled: event.target.checked })}
                  disabled={!developerModeSettings.enabled}
                />
                <span>
                  <strong>Enable developer barcode</strong>
                  <small>Activates a special barcode and PIN combination for developer access.</small>
                </span>
              </label>

              <label className="field">
                <span>Developer Barcode</span>
                <input
                  className="input"
                  value={developerModeSettings.developerBarcode}
                  onChange={(event) => updateDeveloperModeSettings({ developerBarcode: event.target.value })}
                  placeholder="0067"
                  disabled={!developerModeSettings.enabled}
                />
              </label>

              <label className="field">
                <span>Developer PIN</span>
                <input
                  className="input"
                  type="password"
                  value={developerModeSettings.developerPin}
                  onChange={(event) => updateDeveloperModeSettings({ developerPin: event.target.value })}
                  placeholder="0067"
                  disabled={!developerModeSettings.enabled}
                />
              </label>
            </div>
          </div>
        </div>
      ) : (
        <div className="card offline-readiness-card">
          <div className="panel-head">
            <div>
              <h3>Offline Readiness</h3>
              <span className="sub">Confirm that this terminal has enough local data to continue during a network failure.</span>
            </div>
            <span className={`offline-ready-badge ${readiness.ready ? 'ready' : 'incomplete'}`}>
              {readinessLoading ? 'Checking…' : readiness.ready ? 'Ready for Offline Use' : 'Offline Data Incomplete'}
            </span>
          </div>
          <div className="panel-body">
            <div className="offline-terminal-summary">
              <div><span>Terminal</span><strong>{readiness.terminalName || 'This terminal'}</strong><small>{readiness.terminalId || ''}</small></div>
              <div><span>Last successful sync</span><strong>{readiness.lastDownloadAt ? new Date(readiness.lastDownloadAt).toLocaleString('en-PH') : 'Not recorded'}</strong></div>
              <div><span>Pending uploads</span><strong>{readiness.pending || 0}</strong></div>
              <div><span>Failed operations</span><strong className={readiness.failed ? 'readiness-danger' : ''}>{readiness.failed || 0}</strong></div>
            </div>

            <div className="offline-readiness-grid">
              {[
                ['Product catalog', readiness.products, readiness.products > 0],
                ['Categories', readiness.categories, readiness.categories > 0],
                ['Staff accounts', readiness.users, readiness.users > 0],
                ['Cashier offline logins', readiness.offlineCashierLogins, readiness.offlineCashierLogins > 0],
                ['Manager approvals', readiness.managerApprovals, readiness.managerApprovals > 0],
                ['Authorization barcodes', readiness.authorizationBarcodes, true],
                ['Cached transactions', readiness.receipts, true],
                ['Sync queue health', readiness.failed ? `${readiness.failed} failed` : 'Healthy', readiness.failed === 0],
              ].map(([label, value, passed]) => (
                <div className={`offline-check ${passed ? 'passed' : 'missing'}`} key={label}>
                  <span className="offline-check-icon">{passed ? '✓' : '!'}</span>
                  <div><strong>{label}</strong><small>{value}</small></div>
                </div>
              ))}
            </div>

            <div className="offline-readiness-actions">
              <button className="btn btn-primary" onClick={downloadOfflineData} disabled={downloadingOfflineData}>
                <IconDownload size={16} /> {downloadingOfflineData ? 'Downloading…' : 'Download Latest Data for Offline Use'}
              </button>
              <button className="btn btn-outline" onClick={async () => setReadiness(await api.offlineReadiness())}>Test Offline Readiness</button>
            </div>
            {Array.isArray(readiness.failedDetails) && readiness.failedDetails.length > 0 && (
              <div className="offline-failure-list">
                <h4>Failed Operations</h4>
                {readiness.failedDetails.map((failure) => (
                  <div className="offline-failure-row" key={failure.id}>
                    <div><strong>{failure.record}</strong><small>{failure.source} · {failure.type}</small></div>
                    <p>{failure.error}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {developerPinModalOpen && (
        <Modal
          title="Enable Developer Mode"
          onClose={closeDeveloperPinModal}
          footer={(
            <>
              <button type="button" className="btn btn-outline" onClick={closeDeveloperPinModal}>Cancel</button>
              <button type="submit" className="btn btn-primary" form="developer-pin-form">Enable Developer Mode</button>
            </>
          )}
        >
          <form id="developer-pin-form" onSubmit={confirmDeveloperMode}>
            <label className="field">
              <span>Developer PIN</span>
              <input
                className="input"
                type="password"
                value={developerPinInput}
                placeholder="Enter developer PIN"
                onChange={(event) => {
                  setDeveloperPinInput(event.target.value)
                  setDeveloperPinError('')
                }}
                autoFocus
                autoComplete="off"
              />
            </label>
            {developerPinError && <div className="alert error" role="alert">{developerPinError}</div>}
          </form>
        </Modal>
      )}

      {toast && <div className="toast"><IconSettings size={15} /> {toast}</div>}
    </>
  )
}
