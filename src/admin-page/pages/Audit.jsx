import { useCallback, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import { IconDollar, IconDownload, IconList, IconSearch, IconUsers } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { currentAdminUser } from '../auth'

const AUDIT_REVIEW_KEY = 'nexa_reviewed_cash_audits'
const PAGE_SIZE = 10

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function monthStartDate() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
}

function lastDaysDate(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

function filterDates(range, customFrom, customTo) {
  if (range === 'today') return { fromDate: todayDate(), toDate: todayDate() }
  if (range === '7days') return { fromDate: lastDaysDate(6), toDate: todayDate() }
  if (range === 'month') return { fromDate: monthStartDate(), toDate: todayDate() }
  if (range === 'custom') return { fromDate: customFrom, toDate: customTo }
  return { fromDate: '', toDate: '' }
}

function amountAfter(label, detail = '') {
  const pattern = new RegExp(`${label}\\s+PHP\\s*([+-]?[\\d,.]+)`, 'i')
  const match = String(detail).match(pattern)
  return match ? Number(match[1].replace(/,/g, '')) || 0 : 0
}

function cashFlowAmount(log) {
  const detail = String(log.detail || '')
  const signed = amountAfter('signed', detail)
  if (signed) return signed
  const amount = amountAfter(log.action, detail) || amountAfter('Cash out', detail) || amountAfter('Cash in', detail)
  return log.action === 'Cash Out' ? -Math.abs(amount) : Math.abs(amount)
}

function cashierNameFromDetail(detail = '', fallback = 'Cashier') {
  const text = String(detail)
  return text.match(/by\s+(.+?)\s+approved by/i)?.[1]
    || text.match(/Cash audit by\s+(.+?):/i)?.[1]
    || text.match(/Shift (?:opened|closed) by\s+(.+?):/i)?.[1]
    || text.match(/by\s+(.+?)(?:\.|;|\s+Device)/i)?.[1]
    || fallback
}

function categoryFromDetail(detail = '') {
  return String(detail).match(/category\s+([^;.)]+)/i)?.[1]?.trim() || ''
}

function varianceStatus(actualValue, expectedValue, hasAudit) {
  if (!hasAudit) return { text: 'Missing Closing Count', badge: 'badge-warning' }
  const variance = (Number(actualValue) || 0) - (Number(expectedValue) || 0)
  if (Math.abs(variance) < 0.01) return { text: 'Balanced', badge: 'badge-success' }
  if (variance < 0) return { text: 'Short', badge: 'badge-danger' }
  return { text: 'Over', badge: 'badge-info' }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('en-PH') : '-'
}

function formatDateOnly(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) : ''
}

function rangeLabel(range, fromDate, toDate) {
  if (range === 'all') return 'All dates'
  if (fromDate && toDate && fromDate === toDate) return formatDateOnly(fromDate)
  if (fromDate && toDate) return `${formatDateOnly(fromDate)} - ${formatDateOnly(toDate)}`
  if (fromDate) return `From ${formatDateOnly(fromDate)}`
  if (toDate) return `Until ${formatDateOnly(toDate)}`
  return 'No date selected'
}

function deviceFromDetail(detail = '') {
  return String(detail).match(/Device\s+([^.;]+)/i)?.[1]?.trim() || ''
}

function textAfter(label, detail = '') {
  return String(detail).match(new RegExp(`${label}\\s+([^.,;]+(?:,\\s*[^.,;]+)*)`, 'i'))?.[1]?.trim() || ''
}

function countModeFromDetail(detail = '') {
  const detail_str = String(detail || '')
  const match = detail_str.match(/count\s+mode:\s*([a-z\-]+)/i)
  return match ? match[1].trim().toLowerCase() : ''
}

function hasAdminOverrideMarker(detail = '') {
  return /admin\s+override:\s*(admin|true|approved)/i.test(String(detail || ''))
}

function isAdminOverride(detail = '') {
  return hasAdminOverrideMarker(detail) || countModeFromDetail(detail) === 'admin-override'
}

function isDenominationCount(detail = '') {
  return countModeFromDetail(detail) === 'denomination'
}

function breakdownFromDetail(detail = '') {
  return String(detail).match(/denominations:\s*(.+?)(?=;|$)/i)?.[1]?.trim() || textAfter('breakdown', detail)
}

function loadReviewedAudits() {
  try {
    return JSON.parse(localStorage.getItem(AUDIT_REVIEW_KEY) || '{}')
  } catch {
    return {}
  }
}

export default function Audit() {
  const { data: receipts, loading: receiptsLoading } = useApi(api.receipts, [])
  const { data: logs, loading: logsLoading } = useApi(api.activityLogs, [])
  const [subTab, setSubTab] = useState('summary')
  const [dateRange, setDateRange] = useState('today')
  const [query, setQuery] = useState('')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [logDateRange, setLogDateRange] = useState('today')
  const [logCustomFrom, setLogCustomFrom] = useState('')
  const [logCustomTo, setLogCustomTo] = useState('')
  const [logAction, setLogAction] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const [logVisibleState, setLogVisibleState] = useState({ key: '', count: PAGE_SIZE })
  const [toast, setToast] = useState('')
  const [reviewedAudits, setReviewedAudits] = useState(loadReviewedAudits)

  const { fromDate, toDate } = filterDates(dateRange, customFrom, customTo)
  const reviewKey = `${fromDate || 'all'}:${toDate || 'all'}`
  const reviewed = reviewedAudits[reviewKey]
  const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
  const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null
  const selectedDateLabel = rangeLabel(dateRange, fromDate, toDate)
  const { fromDate: logFromDate, toDate: logToDate } = filterDates(logDateRange, logCustomFrom, logCustomTo)
  const logFromTime = logFromDate ? new Date(`${logFromDate}T00:00:00`).getTime() : null
  const logToTime = logToDate ? new Date(`${logToDate}T23:59:59.999`).getTime() : null
  const selectedLogDateLabel = rangeLabel(logDateRange, logFromDate, logToDate)
  const inRange = useCallback((value) => {
    const time = new Date(value).getTime()
    return (!fromTime || time >= fromTime) && (!toTime || time <= toTime)
  }, [fromTime, toTime])
  const inLogRange = useCallback((value) => {
    const time = new Date(value).getTime()
    return (!logFromTime || time >= logFromTime) && (!logToTime || time <= logToTime)
  }, [logFromTime, logToTime])

  const auditRows = useMemo(() => {
    const rows = new Map()
    const ensure = (name) => {
      const key = name || 'Cashier'
      if (!rows.has(key)) {
        rows.set(key, {
          cashierName: key,
          cashBeginning: 0,
          cashSales: 0,
          cashIn: 0,
          cashOut: 0,
          expectedCashEnding: 0,
          actualCashEnding: 0,
          variance: 0,
          hasManualAudit: false,
          automaticCashCount: 0,
          countMode: '',
          breakdown: '',
          isAdminOverride: false,
          registerOpens: 0,
          cashFlowEntries: 0,
          securityAlerts: 0,
          entries: [],
          latestShiftAuditTime: 0,
          latestShiftOpenTime: 0,
        })
      }
      return rows.get(key)
    }

    for (const receipt of receipts || []) {
      if (!inRange(receipt.createdAt)) continue
      const row = ensure(receipt.cashierName || 'Cashier')
      const method = String(receipt.paymentMethod || '').toLowerCase()
      if (method === 'cash') row.cashSales += Number(receipt.cashAmount || receipt.totalAmount) || 0
      if (method === 'split') row.cashSales += Number(receipt.splitPayments?.cash || receipt.cashAmount) || 0
    }

    for (const log of logs || []) {
      if (!inRange(log.time)) continue
      if (log.action === 'Cash In' || log.action === 'Cash Out') {
        const amount = cashFlowAmount(log)
        const row = ensure(cashierNameFromDetail(log.detail, log.user || 'Cashier'))
        row.cashFlowEntries += 1
        if (amount >= 0) row.cashIn += amount
        else row.cashOut += Math.abs(amount)
        row.entries.push({ ...log, amount, category: categoryFromDetail(log.detail), device: deviceFromDetail(log.detail) })
      }
      if (log.action === 'Cash Audit' || log.action === 'Shift Close') {
        const row = ensure(cashierNameFromDetail(log.detail, log.user || 'Cashier'))
        const logTime = new Date(log.time).getTime() || 0
        const isLatestShiftAudit = logTime >= row.latestShiftAuditTime
        const countMode = countModeFromDetail(log.detail)
        const isAdmin = isAdminOverride(log.detail)
        const breakdown = breakdownFromDetail(log.detail)
        
        if (isLatestShiftAudit) {
          row.latestShiftAuditTime = logTime
          row.cashBeginning = amountAfter('beginning', log.detail) || row.cashBeginning
          row.expectedCashEnding = amountAfter('expected', log.detail) || row.expectedCashEnding
          row.actualCashEnding = amountAfter('actual', log.detail) || amountAfter('on hand', log.detail) || row.actualCashEnding
          row.automaticCashCount = amountAfter('automatic cash count', log.detail) || row.automaticCashCount
          // Always set countMode from the log detail, never fallback to old value
          row.countMode = countMode
          row.breakdown = breakdown
          row.variance = amountAfter('variance', log.detail)
          row.hasManualAudit = true
          // Always set isAdminOverride from current log
          row.isAdminOverride = isAdmin
        }
        row.entries.push({
          ...log,
          amount: amountAfter('actual', log.detail) || amountAfter('on hand', log.detail) || 0,
          category: countMode ? `Count: ${countMode}` : '',
          device: deviceFromDetail(log.detail),
          automaticCashCount: amountAfter('automatic cash count', log.detail),
          breakdown,
          isAdminOverride: isAdmin,
        })
      }
      if (log.action === 'Shift Open') {
        const row = ensure(cashierNameFromDetail(log.detail, log.user || 'Cashier'))
        const logTime = new Date(log.time).getTime() || 0
        const beginning = amountAfter('beginning', log.detail)
        if (!row.hasManualAudit && logTime >= row.latestShiftOpenTime) {
          row.latestShiftOpenTime = logTime
          row.cashBeginning = beginning || row.cashBeginning
        }
        row.entries.push({ ...log, amount: beginning, device: deviceFromDetail(log.detail) })
      }
      if (log.action === 'Cash Register Opened') {
        const row = ensure(cashierNameFromDetail(log.detail, log.user || 'Cashier'))
        row.registerOpens += 1
        row.entries.push({
          ...log,
          amount: amountAfter('cash out', log.detail) || amountAfter('cash in', log.detail) || 0,
          category: 'Drawer open',
          device: deviceFromDetail(log.detail),
        })
      }
      if (log.action === 'Security Alert' || log.action === 'Session Locked' || log.action === 'Session Unlocked') {
        const row = ensure(cashierNameFromDetail(log.detail, log.user || 'Cashier'))
        if (log.action === 'Security Alert') row.securityAlerts += 1
        row.entries.push({
          ...log,
          amount: 0,
          category: log.action,
          device: deviceFromDetail(log.detail),
        })
      }
    }

    return [...rows.values()].map((row) => {
      const expected = row.expectedCashEnding || (row.cashBeginning + row.cashSales + row.cashIn - row.cashOut)
      const actual = row.hasManualAudit ? row.actualCashEnding : expected
      const variance = row.hasManualAudit
        ? (Number.isFinite(row.variance) && Math.abs(row.variance) > 0.000001 ? row.variance : (actual - expected))
        : 0
      const flags = []
      if (row.isAdminOverride) flags.push('⚠️ Admin Override')
      if (!row.hasManualAudit) flags.push('Missing closing count')
      if (Math.abs(variance) >= 1) flags.push(variance < 0 ? 'Cash shortage' : 'Cash overage')
      if (row.registerOpens >= 5) flags.push('Many drawer opens')
      if (row.registerOpens > row.cashFlowEntries + 3) flags.push('Drawer opens need review')
      if (row.securityAlerts > 0) flags.push(`${row.securityAlerts} security alert(s)`)
      if (row.cashOut > 0 && row.entries.some((entry) => entry.action === 'Cash Out' && !entry.category)) {
        flags.push('Cash out missing category')
      }
      return {
        ...row,
        expectedCashEnding: expected,
        actualCashEnding: actual,
        variance,
        status: varianceStatus(actual, expected, row.hasManualAudit),
        flags,
      }
    }).sort((a, b) => a.cashierName.localeCompare(b.cashierName))
  }, [logs, receipts, inRange])

  const auditLogRows = useMemo(() => {
    const auditActions = new Set([
      'Shift Open',
      'Shift Close',
      'Cash Audit',
      'Cash Register Opened',
      'Cash In',
      'Cash Out',
      'Security Alert',
      'Session Locked',
      'Session Unlocked',
    ])
    return (logs || [])
      .filter((log) => auditActions.has(log.action) && inLogRange(log.time))
      .map((log) => {
        const countMode = countModeFromDetail(log.detail)
        return {
          ...log,
          cashierName: cashierNameFromDetail(log.detail, log.user || 'Cashier'),
          device: deviceFromDetail(log.detail),
          amount: log.action === 'Cash In' || log.action === 'Cash Out'
            ? Math.abs(cashFlowAmount(log))
            : amountAfter('actual', log.detail)
              || amountAfter('beginning', log.detail)
              || amountAfter('cash out', log.detail)
              || amountAfter('cash in', log.detail)
              || 0,
          isAdminOverride: isAdminOverride(log.detail),
          countMode,
          breakdown: breakdownFromDetail(log.detail),
        }
      })
      .sort((a, b) => new Date(b.time) - new Date(a.time))
  }, [logs, inLogRange])

  const search = query.trim().toLowerCase()
  const filteredAuditRows = useMemo(() => {
    if (!search) return auditRows
    return auditRows.filter((row) => [
      row.cashierName,
      row.status?.text,
      row.flags.join(' '),
      row.breakdown,
      row.countMode,
      row.cashBeginning,
      row.cashSales,
      row.cashIn,
      row.cashOut,
      row.expectedCashEnding,
      row.actualCashEnding,
      row.variance,
    ].some((value) => String(value || '').toLowerCase().includes(search)))
  }, [auditRows, search])

  const logSearch = logQuery.trim().toLowerCase()
  const logActionOptions = useMemo(() => (
    [...new Set(auditLogRows.map((log) => log.action).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  ), [auditLogRows])
  const filteredAuditLogRows = useMemo(() => {
    return auditLogRows.filter((log) => [
      log.cashierName,
      log.action,
      log.device,
      log.amount,
      log.detail,
      log.time,
    ].some((value) => String(value || '').toLowerCase().includes(logSearch))
      && (logAction === 'all' || log.action === logAction))
  }, [auditLogRows, logAction, logSearch])
  const logVisibleKey = [logAction, logCustomFrom, logCustomTo, logDateRange, logQuery].join('|')
  const logVisibleCount = logVisibleState.key === logVisibleKey ? logVisibleState.count : PAGE_SIZE
  const visibleAuditLogRows = filteredAuditLogRows.slice(0, logVisibleCount)

  const totalActual = filteredAuditRows.reduce((sum, row) => sum + row.actualCashEnding, 0)
  const totalCashIn = filteredAuditRows.reduce((sum, row) => sum + row.cashIn, 0)
  const totalCashOut = filteredAuditRows.reduce((sum, row) => sum + row.cashOut, 0)
  const totalVariance = filteredAuditRows.reduce((sum, row) => sum + row.variance, 0)

  async function exportAudit() {
    const result = await exportCsv(`cash-audit-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Cashier', 'Cash Beginning', 'Cash Sales', 'Cash In', 'Cash Out', 'Register Opens', 'Expected Ending', 'Actual Ending', 'Automatic Cash Count', 'Count Mode', 'Breakdown', 'Variance', 'Status', 'Flags'],
      ...filteredAuditRows.map((row) => [
        row.cashierName,
        row.cashBeginning,
        row.cashSales,
        row.cashIn,
        row.cashOut,
        row.registerOpens,
        row.expectedCashEnding,
        row.actualCashEnding,
        row.automaticCashCount,
        row.countMode || 'manual',
        row.breakdown,
        row.variance,
        row.status.text,
        row.flags.join('; '),
      ]),
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`Audit exported to ${result.path}`)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function markReviewed() {
    const reviewedAt = new Date().toISOString()
    const next = {
      ...reviewedAudits,
      [reviewKey]: {
        reviewedAt,
        rowCount: filteredAuditRows.length,
      },
    }
    localStorage.setItem(AUDIT_REVIEW_KEY, JSON.stringify(next))
    setReviewedAudits(next)
    const admin = currentAdminUser()
    await api.markAuditReviewed?.({
      fromDate,
      toDate,
      rowCount: filteredAuditRows.length,
      reviewedBy: admin?.id,
    }).catch(() => null)
    setToast('Audit range marked as reviewed.')
    window.setTimeout(() => setToast(''), 2400)
  }

  if (receiptsLoading || logsLoading) {
    return (
      <>
        <PageHeader title="Audit" subtitle="Loading cashier audit data..." />
        <div className="card"><div className="empty"><h4>Loading audit records</h4></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Audit" subtitle="Cash flow, shift reconciliation, and cashier variance review.">
        <span className="badge badge-neutral">{selectedDateLabel}</span>
        {reviewed && <span className="badge badge-success">Reviewed {formatDate(reviewed.reviewedAt)}</span>}
        <button className="btn btn-outline" onClick={markReviewed} disabled={filteredAuditRows.length === 0}>
          Mark Reviewed
        </button>
        <button className="btn btn-outline" onClick={exportAudit} disabled={filteredAuditRows.length === 0}>
          <IconDownload size={16} /> Export
        </button>
      </PageHeader>
      {toast && <div className="toast"><IconDownload size={15} /> {toast}</div>}

      <div className="stat-grid cols-3">
        <StatCard label="Cashiers" tone="indigo" icon={IconUsers} value={filteredAuditRows.length} foot="with cash activity" />
        <StatCard label="Actual Cash" tone="green" icon={IconDollar} value={peso(totalActual)} foot="Counted or expected cash" />
        <StatCard label="Variance" tone={totalVariance < 0 ? 'red' : 'blue'} icon={IconList} value={peso(totalVariance)} foot={`${peso(totalCashIn)} in, ${peso(totalCashOut)} out`} />
      </div>

      <div className="scan-mode-row analytics-tabs">
        <button
          type="button"
          className={`scan-mode ${subTab === 'summary' ? 'active' : ''}`}
          onClick={() => setSubTab('summary')}
        >
          Summary
        </button>
        <button
          type="button"
          className={`scan-mode ${subTab === 'logs' ? 'active' : ''}`}
          onClick={() => setSubTab('logs')}
        >
          Audit Logs
        </button>
      </div>

      {subTab === 'summary' ? (
      <>
      <div className="card">
        <div className="panel-body">
          <div className="receipt-filter-grid compact-filter-grid">
            <div className="field span-2">
              <span>Search Audit</span>
              <div className="input-search">
                <IconSearch size={16} />
                <input
                  className="input"
                  placeholder="Search cashier, amount, action, device..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            <label className="field">
              <span>Date Range</span>
              <select className="select" value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="7days">Last 7 days</option>
                <option value="month">This month</option>
                <option value="custom">Custom range</option>
              </select>
            </label>
            {dateRange === 'custom' && (
              <>
                <label className="field">
                  <span>From</span>
                  <input className="input" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
                </label>
                <label className="field">
                  <span>To</span>
                  <input className="input" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
                </label>
              </>
            )}
            <label className="field">
              <span>Selected Date</span>
              <div className="input" style={{ display: 'flex', alignItems: 'center', minHeight: 36 }}>
                {selectedDateLabel}
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Sales Reconciliation</h3>
            <span className="sub">Cash sales and drawer variance by cashier for {selectedDateLabel}.</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Cashier</th>
                <th>Beginning</th>
                <th>Cash Sales</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Count Method</th>
                <th>Variance</th>
                <th>Status</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {filteredAuditRows.map((row) => (
                <tr key={row.cashierName}>
                  <td>{row.cashierName}</td>
                  <td>{peso(row.cashBeginning)}</td>
                  <td>{peso(row.cashSales)}</td>
                  <td>{peso(row.expectedCashEnding)}</td>
                  <td><strong>{peso(row.actualCashEnding)}</strong></td>
                  <td>
                    {row.isAdminOverride ? (
                      <span className="badge" style={{ backgroundColor: '#fed7aa', color: '#92400e' }}>Admin Override</span>
                    ) : row.countMode === 'denomination' ? (
                      <span className="badge badge-success" title={row.breakdown}>{row.breakdown || 'Denomination'}</span>
                    ) : (
                      <span className="muted">Manual</span>
                    )}
                  </td>
                  <td>{peso(row.variance)}</td>
                  <td><span className={`badge ${row.status.badge}`}>{row.status.text}</span></td>
                  <td>{row.flags.length ? row.flags.join(', ') : <span className="muted">None</span>}</td>
                </tr>
              ))}
              {filteredAuditRows.length === 0 && (
                <tr><td colSpan="9" className="muted">No sales reconciliation matches the selected filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Cash Flow</h3>
            <span className="sub">Cash in, cash out, and drawer-open activity separated from sales.</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Cashier</th>
                <th>Cash In</th>
                <th>Cash Out</th>
                <th>Net Flow</th>
                <th>Register Opens</th>
                <th>Security Alerts</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {filteredAuditRows.map((row) => (
                <tr key={`${row.cashierName}-flow`}>
                  <td>{row.cashierName}</td>
                  <td>{peso(row.cashIn)}</td>
                  <td>{peso(row.cashOut)}</td>
                  <td><strong>{peso(row.cashIn - row.cashOut)}</strong></td>
                  <td>{row.registerOpens}</td>
                  <td>{row.securityAlerts}</td>
                  <td>{row.flags.length ? row.flags.join(', ') : <span className="muted">None</span>}</td>
                </tr>
              ))}
              {filteredAuditRows.length === 0 && (
                <tr><td colSpan="7" className="muted">No cash flow matches the selected filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      ) : (
      <>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="panel-body">
          <div className="receipt-filter-grid compact-filter-grid">
            <div className="field span-2">
              <span>Search Logs</span>
              <div className="input-search">
                <IconSearch size={16} />
                <input
                  className="input"
                  placeholder="Search cashier, action, device, details..."
                  value={logQuery}
                  onChange={(event) => setLogQuery(event.target.value)}
                />
              </div>
            </div>
            <label className="field">
              <span>Date Range</span>
              <select className="select" value={logDateRange} onChange={(event) => setLogDateRange(event.target.value)}>
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="7days">Last 7 days</option>
                <option value="month">This month</option>
                <option value="custom">Custom range</option>
              </select>
            </label>
            <label className="field">
              <span>Actions</span>
              <select className="select" value={logAction} onChange={(event) => setLogAction(event.target.value)}>
                <option value="all">All actions</option>
                {logActionOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            {logDateRange === 'custom' && (
              <>
                <label className="field">
                  <span>From</span>
                  <input className="input" type="date" value={logCustomFrom} onChange={(event) => setLogCustomFrom(event.target.value)} />
                </label>
                <label className="field">
                  <span>To</span>
                  <input className="input" type="date" value={logCustomTo} onChange={(event) => setLogCustomTo(event.target.value)} />
                </label>
              </>
            )}
            <label className="field">
              <span>Selected Date</span>
              <div className="input" style={{ display: 'flex', alignItems: 'center', minHeight: 36 }}>
                {selectedLogDateLabel}
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Audit Logs</h3>
            <span className="sub">Cash drawer, cash flow, shift, count, and security events for {selectedLogDateLabel}.</span>
          </div>
          <span className="muted">{filteredAuditLogRows.length} result(s)</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Cashier</th>
                <th>Action</th>
                <th>Device</th>
                <th>Amount</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visibleAuditLogRows.map((log) => (
                <tr key={log.id}>
                  <td>{formatDate(log.time)}</td>
                  <td>{log.cashierName}</td>
                  <td>
                    <span className="badge badge-info">{log.action}</span>
                    {log.isAdminOverride && <span className="badge" style={{ backgroundColor: '#fed7aa', color: '#92400e', marginLeft: 6 }}>🔐 Admin</span>}
                    {log.countMode === 'denomination' && <span className="badge badge-success" style={{ marginLeft: 6 }} title={log.breakdown}>📊 {log.breakdown}</span>}
                  </td>
                  <td>{log.device || '-'}</td>
                  <td>{log.amount ? peso(log.amount) : '-'}</td>
                  <td className="muted">{log.detail}</td>
                </tr>
              ))}
              {filteredAuditLogRows.length === 0 && (
                <tr><td colSpan="6" className="muted">No audit logs for this date range.</td></tr>
              )}
            </tbody>
          </table>
          {filteredAuditLogRows.length > visibleAuditLogRows.length && (
            <div className="table-more-row">
              <button
                className="btn btn-outline"
                onClick={() => setLogVisibleState({ key: logVisibleKey, count: logVisibleCount + PAGE_SIZE })}
              >
                Show More ({filteredAuditLogRows.length - visibleAuditLogRows.length} remaining)
              </button>
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </>
  )
}
