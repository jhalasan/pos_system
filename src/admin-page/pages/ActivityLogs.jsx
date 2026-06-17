import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Modal from '../components/Modal'
import { IconDownload, IconList } from '../components/Icons'
import { api } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'

const actionBadge = {
  Login: 'badge-info',
  Logout: 'badge-neutral',
  Sale: 'badge-success',
  Product: 'badge-neutral',
  Inventory: 'badge-warning',
  Cashier: 'badge-info',
  Sync: 'badge-info',
  'Transaction Void': 'badge-danger',
  Discount: 'badge-success',
  Discounts: 'badge-success',
  'Stock Update': 'badge-warning',
  'Password Reset': 'badge-info',
  'Cloud Sync': 'badge-info',
}

function getDateRange(range) {
  const now = new Date()
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)

  if (range === 'Today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { start, end }
  }

  if (range === 'Last 7 Days') {
    const start = new Date(now)
    start.setDate(start.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    return { start, end }
  }

  if (range === 'Last 30 Days') {
    const start = new Date(now)
    start.setDate(start.getDate() - 29)
    start.setHours(0, 0, 0, 0)
    return { start, end }
  }

  return { start: null, end: null }
}

function getCustomDateRange(from, to) {
  const start = from ? new Date(`${from}T00:00:00`) : null
  const end = to ? new Date(`${to}T23:59:59.999`) : null
  return { start, end }
}

function logMatchesFilters(log, filters) {
  const mu = filters.userType === 'All' || log.userType === filters.userType
  const ma = filters.action === 'All' || log.action === filters.action ||
    (filters.action === 'Discounts' && log.action === 'Discount')
  const dt = new Date(log.time)
  const md = (!filters.range.start || dt >= filters.range.start) &&
    (!filters.range.end || dt <= filters.range.end)
  return mu && ma && md
}

function actionLabel(action) {
  return action === 'Discount' ? 'Discounts' : action
}

export default function ActivityLogs() {
  const { data: activityLogs, loading, error } = useApi(api.activityLogs, [])
  const [userType, setUserType] = useState('All')
  const [action, setAction] = useState('All')
  const [dateRange, setDateRange] = useState('Today')
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [exportFilters, setExportFilters] = useState({
    userType: 'All',
    action: 'All',
    dateRange: 'Today',
    from: '',
    to: '',
  })

  const actionTypes = [...new Set(['Discounts', ...activityLogs.map((l) => actionLabel(l.action)).filter(Boolean)])]

  const selectedRange = useMemo(() => getDateRange(dateRange), [dateRange])

  const filtered = useMemo(() => {
    return activityLogs.filter((log) => logMatchesFilters(log, {
      userType,
      action,
      range: selectedRange,
    }))
  }, [activityLogs, userType, action, selectedRange])

  const exportPreview = useMemo(() => {
    const range = exportFilters.dateRange === 'Custom'
      ? getCustomDateRange(exportFilters.from, exportFilters.to)
      : getDateRange(exportFilters.dateRange)
    return activityLogs.filter((log) => logMatchesFilters(log, { ...exportFilters, range }))
  }, [activityLogs, exportFilters])

  async function exportLogs() {
    setExporting(true)
    setExportStatus('Exporting...')
    try {
      const result = await exportCsv(`activity-logs-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Timestamp', 'User', 'User Type', 'Action', 'Details'],
      ...exportPreview.map((log) => [
        new Date(log.time).toLocaleString(),
        log.user,
        log.userType,
        actionLabel(log.action),
        log.detail,
      ]),
      ], { directory: getExportLocation(exportLocationKeys.activityLogs) })
      setExportStatus(`Exported in - "${result.path}"`)
      setExportOpen(false)
    } catch (err) {
      setExportStatus(err.message || 'Unable to export logs.')
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Activity Logs" subtitle="Loading activity logs..." />
        <div className="card"><div className="empty"><h4>Loading logs</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Activity Logs" subtitle="Real-time audit trail of all system activities." />
        <div className="card"><div className="empty"><h4>Unable to load logs</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Activity Logs"
        subtitle="Real-time audit trail of all system activities."
      >
        <button className="btn btn-outline" onClick={() => setExportOpen(true)}>
          <IconDownload size={16} /> Export Logs
        </button>
      </PageHeader>
      {exportStatus && <div className="export-status">{exportStatus}</div>}

      <div className="card activity-card">
        <div className="toolbar activity-toolbar">
          <div className="field">
            <select className="select" value={userType} onChange={(e) => setUserType(e.target.value)}>
              <option value="All">All User Types</option>
              <option value="Admin">Admin</option>
              <option value="Cashier">Cashier</option>
            </select>
          </div>
          <div className="field">
            <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="All">All Action Types</option>
              {actionTypes.map((a) => <option key={a}>{a}</option>)}
            </select>
          </div>
          <div className="field">
            <select className="select" value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
              <option value="Today">Today</option>
              <option value="Last 7 Days">Last 7 Days</option>
              <option value="Last 30 Days">Last 30 Days</option>
              <option value="All Time">All Time</option>
            </select>
          </div>
          <span className="count">{filtered.length} record(s)</span>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconList size={24} /></div>
            <h4>No logs found</h4>
            <p>No activity matches the selected filters.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>User Type</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{new Date(l.time).toLocaleString()}</td>
                    <td className="prod-name">{l.user}</td>
                    <td>
                      <span className={'badge ' + (l.userType === 'Admin' ? 'badge-info' : 'badge-neutral')}>
                        {l.userType}
                      </span>
                    </td>
                    <td>
                      <span className={'badge ' + (actionBadge[l.action] || 'badge-neutral')}>
                        {actionLabel(l.action)}
                      </span>
                    </td>
                    <td className="muted">{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {exportOpen && (
        <Modal
          title="Export Activity Logs"
          onClose={() => setExportOpen(false)}
          footer={(
            <>
              <button className="btn btn-outline" onClick={() => setExportOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={exportLogs} disabled={exporting}>
                <IconDownload size={16} /> {exporting ? 'Exporting...' : `Export ${exportPreview.length} Log(s)`}
              </button>
            </>
          )}
        >
          <div className="export-filter-grid">
            <label className="field">
              <span>Date Range</span>
              <select
                className="select"
                value={exportFilters.dateRange}
                onChange={(event) => setExportFilters({ ...exportFilters, dateRange: event.target.value })}
              >
                <option value="Today">Today</option>
                <option value="Last 7 Days">Last 7 Days</option>
                <option value="Last 30 Days">Last 30 Days</option>
                <option value="All Time">All Time</option>
                <option value="Custom">Custom</option>
              </select>
            </label>
            <label className="field">
              <span>User Type</span>
              <select
                className="select"
                value={exportFilters.userType}
                onChange={(event) => setExportFilters({ ...exportFilters, userType: event.target.value })}
              >
                <option value="All">All User Types</option>
                <option value="Admin">Admin</option>
                <option value="Cashier">Cashier</option>
              </select>
            </label>
            <label className="field">
              <span>Action Type</span>
              <select
                className="select"
                value={exportFilters.action}
                onChange={(event) => setExportFilters({ ...exportFilters, action: event.target.value })}
              >
                <option value="All">All Action Types</option>
                {actionTypes.map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
            {exportFilters.dateRange === 'Custom' && (
              <>
                <label className="field">
                  <span>From</span>
                  <input
                    className="input"
                    type="date"
                    value={exportFilters.from}
                    onChange={(event) => setExportFilters({ ...exportFilters, from: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>To</span>
                  <input
                    className="input"
                    type="date"
                    value={exportFilters.to}
                    onChange={(event) => setExportFilters({ ...exportFilters, to: event.target.value })}
                  />
                </label>
              </>
            )}
          </div>
          <div className="export-summary">{exportPreview.length} matching record(s)</div>
        </Modal>
      )}
    </>
  )
}
