import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import BrandedLoader from '../../components/BrandedLoader'
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

const emptyReadiness = { ready: false, products: 0, cashierProducts: 0, categories: 0, users: 0, authorizationBarcodes: 0, managerApprovals: 0, offlineCashierLogins: 0, receipts: 0, pending: 0, failed: 0 }

export default function Settings() {
  const [searchParams] = useSearchParams()
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
  const [activeTab, setActiveTab] = useState(() => {
    const requested = searchParams.get('tab')
    return ['general', 'developer', 'offline', 'data'].includes(requested) ? requested : 'general'
  })
  const { data: readiness, setData: setReadiness, loading: readinessLoading } = useApi(api.offlineReadiness, emptyReadiness)
  const [downloadingOfflineData, setDownloadingOfflineData] = useState(false)
  const [offlineTestRunning, setOfflineTestRunning] = useState(false)
  const [resetScope, setResetScope] = useState('catalog')
  const [resettingLocalData, setResettingLocalData] = useState(false)
  const [offlineTest, setOfflineTest] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nexa_offline_self_test') || 'null') } catch { return null }
  })
  const [importStatus, setImportStatus] = useState(null)
  const [backups, setBackups] = useState([])
  const [backupPolicy, setBackupPolicy] = useState(null)
  const [maintenanceReport, setMaintenanceReport] = useState(null)
  const [dataAdminLoading, setDataAdminLoading] = useState(false)
  const [importStatusError, setImportStatusError] = useState('')
  const [backupError, setBackupError] = useState('')

  function flash(message) {
    setToast(message)
    setTimeout(() => setToast(''), 2400)
  }

  async function runOfflineSelfTest() {
    setOfflineTestRunning(true)
    try {
      const result = api.offlineSelfTest ? await api.offlineSelfTest() : { passed: false, testedAt: new Date().toISOString(), checks: [] }
      setOfflineTest(result)
      localStorage.setItem('nexa_offline_self_test', JSON.stringify(result))
      setReadiness(await api.offlineReadiness())
      flash(result.passed ? 'Offline self-test passed.' : 'Offline self-test found items that need attention.')
    } catch (error) {
      flash(error.message || 'Offline self-test could not run.')
    } finally {
      setOfflineTestRunning(false)
    }
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

  async function resetLocalData() {
    const labels = {
      catalog: 'downloaded product and category catalogs',
      logins: 'cached cashier and manager login profiles',
      receipts: 'cached receipts and local transaction history',
      'sync-status': 'saved sync messages and offline self-test result',
      full: 'all downloaded terminal data',
    }
    const confirmation = prompt(`Reset ${labels[resetScope]}?\n\nCloud records, terminal identity, printer settings, and application preferences will not be deleted.\n\nType exactly: RESET TERMINAL`)
    if (confirmation !== 'RESET TERMINAL') return flash('Local reset cancelled; confirmation did not match.')
    setResettingLocalData(true)
    try {
      const result = await api.resetLocalData({ scope: resetScope, confirmation })
      setReadiness(result.readiness)
      if (['sync-status', 'full'].includes(resetScope)) setOfflineTest(null)
      if (result.refreshed) {
        const test = await api.offlineSelfTest()
        setOfflineTest(test)
        localStorage.setItem('nexa_offline_self_test', JSON.stringify(test))
        setReadiness(await api.offlineReadiness())
      }
      flash(result.refreshed ? 'Local data reset, refreshed, and tested.' : 'Selected local cache was cleared.')
    } catch (resetError) {
      flash(resetError.message || 'Unable to reset local data.')
    } finally {
      setResettingLocalData(false)
    }
  }

  async function loadDataAdministration() {
    setActiveTab('data')
    setDataAdminLoading(true)
    const [statusResult, backupResult, policyResult, maintenanceResult] = await Promise.allSettled([api.importStatus(), api.backups(), api.backupPolicy(), api.maintenanceReport()])
    if (statusResult.status === 'fulfilled') {
      setImportStatus(statusResult.value)
      setImportStatusError('')
    } else {
      setImportStatus(null)
      setImportStatusError('Migration status requires the local NEXA API service on port 3001.')
    }
    if (backupResult.status === 'fulfilled') {
      setBackups(backupResult.value)
      setBackupError('')
    } else {
      setBackups([])
      setBackupError('Backup and restore require the local NEXA API service on port 3001.')
    }
    setBackupPolicy(policyResult.status === 'fulfilled' ? policyResult.value : null)
    setMaintenanceReport(maintenanceResult.status === 'fulfilled' ? maintenanceResult.value : null)
    setDataAdminLoading(false)
  }

  async function createBackup() {
    setDataAdminLoading(true)
    try {
      const created = await api.createBackup()
      setBackups(await api.backups())
      setBackupError('')
      flash(`Backup ${created.name} created.`)
    } catch {
      setBackupError('Unable to reach the backup service. Start it with: npm run api')
      flash('Backup service unavailable. Start the local NEXA API service.')
    }
    finally { setDataAdminLoading(false) }
  }

  async function runAutomaticBackup() {
    setDataAdminLoading(true)
    try {
      const result = await api.runAutomaticBackup()
      setBackups(await api.backups())
      setBackupPolicy(await api.backupPolicy())
      flash(result.created ? `Automatic backup ${result.latest} created.` : 'A recent automatic backup already exists.')
    } catch (err) {
      flash(err.message || 'Unable to run automatic backup.')
    } finally { setDataAdminLoading(false) }
  }

  async function restoreBackup(name) {
    const confirmation = prompt(`Restoring replaces the current PocketBase data.\nType exactly: RESTORE ${name}`)
    if (confirmation !== `RESTORE ${name}`) return flash('Restore cancelled; confirmation did not match.')
    try {
      await api.restoreBackup(name, confirmation)
      flash(`Restore started for ${name}. Restart the applications after PocketBase returns.`)
    } catch (err) { flash(err.message || 'Unable to restore backup.') }
  }

  if (loading || adminsLoading) {
    return <PageLoader title="Settings" message="Loading account settings…" />
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
        <button className={activeTab === 'data' ? 'active' : ''} onClick={loadDataAdministration}>Data Administration</button>
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
      </div> : activeTab === 'data' ? (
        <div className="grid-gap">
          <div className="card">
            <div className="panel-head"><div><h3>Legacy Import Monitor</h3><span className="sub">Dry-run totals, completion state, progress, and recent errors.</span></div><button className="btn btn-outline" onClick={loadDataAdministration} disabled={dataAdminLoading}>Refresh</button></div>
            <div className="panel-body">
              {importStatusError ? <div className="alert warning"><strong>Import monitor unavailable</strong><span>{importStatusError}</span></div> : dataAdminLoading && !importStatus ? <BrandedLoader compact message="Loading import status…" /> : (
                <>
                  <div className="offline-terminal-summary">
                    <div><span>Mode</span><strong>{importStatus?.result?.mode || importStatus?.dryRun?.mode || 'Not started'}</strong></div>
                    <div><span>Products planned</span><strong>{importStatus?.dryRun?.counts?.products || 0}</strong></div>
                    <div><span>Sales planned</span><strong>{importStatus?.dryRun?.counts?.sales || 0}</strong></div>
                    <div><span>Completed</span><strong>{importStatus?.result?.completedAt ? new Date(importStatus.result.completedAt).toLocaleString('en-PH') : 'Incomplete / stopped'}</strong></div>
                  </div>
                  {importStatus?.progress?.length > 0 && <pre className="data-admin-log">{importStatus.progress.join('\n')}</pre>}
                  {importStatus?.errors?.length > 0 && <pre className="data-admin-log error">{importStatus.errors.join('\n')}</pre>}
                </>
              )}
            </div>
          </div>
          <div className="card">
            <div className="panel-head"><div><h3>Backups and Restore</h3><span className="sub">Create a PocketBase backup before imports, cleanup, or schema changes.</span></div><div className="panel-head-actions"><button className="btn btn-outline" onClick={runAutomaticBackup} disabled={dataAdminLoading || Boolean(backupError)}>Run Scheduled Backup</button><button className="btn btn-primary" onClick={createBackup} disabled={dataAdminLoading || Boolean(backupError)}>Create Backup</button></div></div>
            <div className="panel-body">
              {backupPolicy && <div className="offline-terminal-summary"><div><span>Automatic backups</span><strong>{backupPolicy.enabled ? 'Enabled' : 'Disabled'}</strong></div><div><span>Schedule</span><strong>Every {backupPolicy.intervalHours} hours</strong></div><div><span>Retention</span><strong>{backupPolicy.retention} backups</strong></div><div><span>Stored automatically</span><strong>{backupPolicy.automaticBackups}</strong></div></div>}
              {backupError ? <div className="alert warning"><strong>Backup service unavailable</strong><span>{backupError}</span></div> : backups.length === 0 ? <div className="empty"><h4>No backups found</h4></div> : backups.map((backup) => (
                <div className="backup-row" key={backup.key || backup.name}><div><strong>{backup.key || backup.name}</strong><small>{backup.modified ? new Date(backup.modified).toLocaleString('en-PH') : ''} · {Number(backup.size || 0).toLocaleString()} bytes</small></div><button className="btn btn-outline" onClick={() => restoreBackup(backup.key || backup.name)}>Restore</button></div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="panel-head"><div><h3>Database Maintenance Report</h3><span className="sub">Read-only checks for catalog and relation problems. No records are changed automatically.</span></div><button className="btn btn-outline" onClick={loadDataAdministration} disabled={dataAdminLoading}>Run Checks</button></div>
            <div className="panel-body">
              {!maintenanceReport ? <div className="empty"><h4>Maintenance report unavailable</h4><p>Start the local API service and run the checks again.</p></div> : <>
                <div className="offline-terminal-summary"><div><span>Products checked</span><strong>{maintenanceReport.products}</strong></div><div><span>Duplicate barcodes</span><strong className={maintenanceReport.duplicateBarcodes.length ? 'readiness-danger' : ''}>{maintenanceReport.duplicateBarcodes.length}</strong></div><div><span>Invalid prices</span><strong className={maintenanceReport.invalidPrices.length ? 'readiness-danger' : ''}>{maintenanceReport.invalidPrices.length}</strong></div><div><span>Uncategorized</span><strong>{maintenanceReport.uncategorized.length}</strong></div></div>
                <div className="maintenance-summary"><span>Invalid stock: <strong>{maintenanceReport.invalidStock.length}</strong></span><span>Orphan sale items: <strong>{maintenanceReport.orphanSaleItems}</strong></span>{maintenanceReport.source && <span>Source: <strong>{maintenanceReport.source}</strong></span>}<span>Checked: <strong>{new Date(maintenanceReport.checkedAt).toLocaleString('en-PH')}</strong></span></div>
                {(maintenanceReport.duplicateBarcodes.length > 0 || maintenanceReport.invalidPrices.length > 0 || maintenanceReport.invalidStock.length > 0) && <div className="alert warning"><strong>Review recommended</strong><span>Resolve catalog warnings in Product Management. Create a backup before bulk corrections.</span></div>}
              </>}
            </div>
          </div>
        </div>
      ) : activeTab === 'developer' ? (
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
            {(() => {
              const steps = [
                ['Terminal identified', Boolean(readiness.terminalId), readiness.terminalName || 'This terminal'],
                ['Catalog downloaded', readiness.products > 0 && readiness.cashierProducts > 0, `${readiness.cashierProducts || 0} cashier products`],
                ['Offline staff access prepared', readiness.users > 0 && readiness.offlineCashierLogins > 0, `${readiness.offlineCashierBarcodeLogins || 0} barcode · ${readiness.offlineCashierPasswordLogins || 0} password`],
                ['Manager approval prepared', readiness.managerApprovals > 0, `${readiness.managerApprovals || 0} approval methods`],
                ['Offline self-test passed', Boolean(offlineTest?.passed), offlineTest?.testedAt ? new Date(offlineTest.testedAt).toLocaleString('en-PH') : 'Not tested'],
              ]
              const complete = steps.filter(([, passed]) => passed).length
              return <div className="offline-setup-guide">
                <div className="offline-setup-head"><div><strong>Terminal Setup</strong><small>{complete} of {steps.length} steps complete</small></div><span>{Math.round((complete / steps.length) * 100)}%</span></div>
                <div className="offline-setup-progress"><i style={{ width: `${(complete / steps.length) * 100}%` }} /></div>
                <div className="offline-setup-steps">{steps.map(([label, passed, detail]) => <div className={passed ? 'complete' : ''} key={label}><b>{passed ? '✓' : '○'}</b><span><strong>{label}</strong><small>{detail}</small></span></div>)}</div>
              </div>
            })()}
            <div className="offline-terminal-summary">
              <div><span>Terminal</span><strong>{readiness.terminalName || 'This terminal'}</strong><small>{readiness.terminalId || ''}</small></div>
              <div><span>Last successful sync</span><strong>{readiness.lastDownloadAt ? new Date(readiness.lastDownloadAt).toLocaleString('en-PH') : 'Not recorded'}</strong></div>
              <div><span>Pending uploads</span><strong>{readiness.pending || 0}</strong></div>
              <div><span>Failed operations</span><strong className={readiness.failed ? 'readiness-danger' : ''}>{readiness.failed || 0}</strong></div>
            </div>

            <div className="offline-readiness-grid">
              {[
                ['Product catalog', readiness.products, readiness.products > 0],
                ['Cashier product catalog', readiness.cashierProducts, readiness.cashierProducts > 0],
                ['Categories', readiness.categories, readiness.categories > 0],
                ['Staff accounts', readiness.users, readiness.users > 0],
                ['Cashier offline logins', `${readiness.offlineCashierBarcodeLogins || 0} barcode · ${readiness.offlineCashierPasswordLogins || 0} password`, readiness.offlineCashierLogins > 0],
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
              <button className="btn btn-outline" onClick={runOfflineSelfTest} disabled={offlineTestRunning}>{offlineTestRunning ? 'Testing Local System…' : 'Run Offline Self-Test'}</button>
            </div>
            {offlineTest && <div className={`offline-test-results ${offlineTest.passed ? 'passed' : 'failed'}`}>
              <div><strong>{offlineTest.passed ? 'Offline self-test passed' : 'Offline setup needs attention'}</strong><small>Tested {new Date(offlineTest.testedAt).toLocaleString('en-PH')}</small></div>
              <div className="offline-test-checks">{offlineTest.checks?.map((check) => <div key={check.key}><b>{check.passed ? '✓' : '!'}</b><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>
            </div>}
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
            <div className="offline-cache-maintenance">
              <div>
                <strong>Local Cache Maintenance</strong>
                <p>Use refresh for normal updates. Reset only when cached terminal data is stale, corrupted, or assigned to another device.</p>
              </div>
              <div className="offline-cache-controls">
                <select className="select" value={resetScope} onChange={(event) => setResetScope(event.target.value)} disabled={resettingLocalData}>
                  <option value="catalog">Reset product and category cache</option>
                  <option value="logins">Reset cached staff access</option>
                  <option value="receipts">Reset cached receipts</option>
                  <option value="sync-status">Clear old sync status</option>
                  <option value="full">Full terminal cache reset</option>
                </select>
                <button className="btn btn-danger" onClick={resetLocalData} disabled={resettingLocalData || readiness.pending > 0 || readiness.failed > 0}>{resettingLocalData ? 'Resetting…' : 'Reset Selected Cache'}</button>
              </div>
              {(readiness.pending > 0 || readiness.failed > 0) && <small className="readiness-danger">Reset is locked until all pending and failed synchronization items are resolved.</small>}
              <small>This does not delete PocketBase records. A catalog, login, or full reset automatically downloads fresh data when online.</small>
            </div>
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
