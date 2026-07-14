import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import StatCard from '../components/StatCard'
import { IconDownload, IconPeso, IconSearch, IconWallet } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { localDateKey } from '../utils/localDate'

const PAGE_SIZE = 10

function formatDate(value) {
  if (!value) return '-'
  return new Date(value).toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function dateOnly(value) {
  return value ? localDateKey(value) : ''
}

function todayDate() {
  return localDateKey()
}

function monthStartDate() {
  const now = new Date()
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), 1))
}

function lastDaysDate(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return localDateKey(date)
}

function filterDates(range, customFrom, customTo) {
  if (range === 'today') return { fromDate: todayDate(), toDate: todayDate() }
  if (range === '7days') return { fromDate: lastDaysDate(6), toDate: todayDate() }
  if (range === 'month') return { fromDate: monthStartDate(), toDate: todayDate() }
  if (range === 'custom') return { fromDate: customFrom, toDate: customTo }
  return { fromDate: '', toDate: '' }
}

function gcashPaymentFromReceipt(receipt) {
  const paymentMethod = String(receipt.paymentMethod || '').toLowerCase()
  const splitGcash = Number(receipt.splitPayments?.gcash) || 0
  const amount = paymentMethod === 'split' ? splitGcash : Number(receipt.gcashAmount || receipt.totalAmount) || 0
  if (paymentMethod !== 'gcash' && splitGcash <= 0) return null

  return {
    id: receipt.id,
    transactionNo: receipt.transactionNo || receipt.receiptNo,
    createdAt: receipt.createdAt,
    cashierName: receipt.cashierName || '',
    paymentType: paymentMethod === 'split' ? 'Split' : 'GCash',
    amount,
    totalAmount: Number(receipt.totalAmount) || 0,
    cashAmount: paymentMethod === 'split' ? Number(receipt.splitPayments?.cash) || 0 : 0,
    referenceNumber: paymentMethod === 'split' ? receipt.splitPayments?.gcashRef : receipt.refNumber,
    status: receipt.rawStatus || receipt.status || 'completed',
  }
}

export default function GCashPayments({ embedded = false, sourceReceipts = null }) {
  const apiResult = useApi(api.gcashPayments, [])
  const payments = sourceReceipts
    ? sourceReceipts.map(gcashPaymentFromReceipt).filter(Boolean)
    : apiResult.data
  const loading = sourceReceipts ? false : apiResult.loading
  const error = sourceReceipts ? '' : apiResult.error
  const [query, setQuery] = useState('')
  const [type, setType] = useState('All')
  const [dateRange, setDateRange] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [cashierName, setCashierName] = useState('all')
  const [status, setStatus] = useState('all')
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const cashierOptions = useMemo(() => {
    const names = new Set()
    for (const payment of payments) {
      if (payment.cashierName) names.add(payment.cashierName)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [payments])

  const filteredPayments = useMemo(() => {
    const search = query.trim().toLowerCase()
    const { fromDate, toDate } = filterDates(dateRange, customFrom, customTo)
    const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
    const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null

    return payments.filter((payment) => {
      const createdTime = new Date(payment.createdAt).getTime()
      const typeMatches = type === 'All' || payment.paymentType === type
      const cashierMatches = cashierName === 'all' || payment.cashierName === cashierName
      const paymentStatus = String(payment.status || 'completed').toLowerCase()
      const statusMatches = status === 'all' || paymentStatus === status
      const dateMatches = (!fromTime || createdTime >= fromTime) && (!toTime || createdTime <= toTime)
      const queryMatches = !search || [
        payment.transactionNo,
        payment.referenceNumber,
        payment.cashierName,
        payment.paymentType,
        payment.status,
      ].some((value) => String(value || '').toLowerCase().includes(search))
      return typeMatches && cashierMatches && statusMatches && dateMatches && queryMatches
    })
  }, [cashierName, customFrom, customTo, dateRange, payments, query, status, type])

  const totalAmount = filteredPayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
  const directTotal = filteredPayments
    .filter((payment) => payment.paymentType === 'GCash')
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
  const splitTotal = filteredPayments
    .filter((payment) => payment.paymentType === 'Split')
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
  const visiblePayments = filteredPayments.slice(0, visibleCount)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisibleCount(PAGE_SIZE))
    return () => window.cancelAnimationFrame(frame)
  }, [cashierName, customFrom, customTo, dateRange, query, status, type])

  async function handleExport() {
    const result = await exportCsv(`gcash-payments-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Date', 'Transaction No.', 'Type', 'Cashier', 'Status', 'GCash Amount', 'Reference No.', 'Sale Total', 'Cash Portion'],
      ...filteredPayments.map((payment) => [
        formatDate(payment.createdAt),
        payment.transactionNo,
        payment.paymentType,
        payment.cashierName,
        payment.status || 'completed',
        Number(payment.amount) || 0,
        payment.referenceNumber || '',
        Number(payment.totalAmount) || 0,
        Number(payment.cashAmount) || 0,
      ]),
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`GCash payments exported to ${result.path}`)
    window.setTimeout(() => setToast(''), 2400)
  }

  if (loading) {
    return <PageLoader title="GCash Payments" message="Loading GCash payment records…" />
  }

  if (error) {
    return (
      <>
        <PageHeader title="GCash Payments" subtitle="Track GCash sales and references." />
        <div className="card"><div className="empty"><h4>Unable to load GCash payments</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      {!embedded && (
        <PageHeader title="GCash Payments" subtitle="Reconcile GCash amounts, transaction numbers, and reference numbers.">
          <button className="btn btn-outline" onClick={handleExport} disabled={filteredPayments.length === 0}>
            <IconDownload size={16} /> Export
          </button>
        </PageHeader>
      )}
      {embedded && (
        <div className="panel-head" style={{ marginBottom: 16 }}>
          <div>
            <h3>GCash Payments</h3>
            <span className="sub">Direct GCash and split payments with a GCash portion.</span>
          </div>
          <button className="btn btn-outline" onClick={handleExport} disabled={filteredPayments.length === 0}>
            <IconDownload size={16} /> Export
          </button>
        </div>
      )}

      <div className="stat-grid cols-3">
        <StatCard label="GCash Total" value={peso(totalAmount)} icon={IconPeso} tone="green" foot={`${filteredPayments.length} payment(s)`} />
        <StatCard label="Direct GCash" value={peso(directTotal)} icon={IconWallet} tone="blue" foot="Single payment" />
        <StatCard label="Split GCash" value={peso(splitTotal)} icon={IconWallet} tone="indigo" foot="GCash portion only" />
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Payment Records</h3>
            <span className="sub">Includes direct GCash and split payments with a GCash portion.</span>
          </div>
        </div>
        <div className="panel-body">
          <div className="receipt-filter-grid compact-filter-grid">
            <div className="input-search">
              <IconSearch size={16} />
              <input
                className="input"
                placeholder="Search transaction, ref, cashier..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
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
            <label className="field">
              <span>Payment Type</span>
              <select className="select" value={type} onChange={(event) => setType(event.target.value)}>
                <option>All</option>
                <option>GCash</option>
                <option>Split</option>
              </select>
            </label>
            <label className="field">
              <span>Cashier</span>
              <select className="select" value={cashierName} onChange={(event) => setCashierName(event.target.value)}>
                <option value="all">All cashiers</option>
                {cashierOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="completed">Completed</option>
                <option value="voided">Voided</option>
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
          </div>
        </div>

        {filteredPayments.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconWallet size={24} /></div>
            <h4>No GCash payments found</h4>
            <p>GCash sales will appear here after cashier transactions are completed.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transaction No.</th>
                  <th>Type</th>
                  <th>Cashier</th>
                  <th>Status</th>
                  <th>Reference No.</th>
                  <th>GCash Amount</th>
                  <th>Sale Total</th>
                </tr>
              </thead>
              <tbody>
                {visiblePayments.map((payment) => (
                  <tr key={`${payment.id}-${payment.paymentType}`}>
                    <td>{formatDate(payment.createdAt)}</td>
                    <td>
                      <div className="prod-name">{payment.transactionNo}</div>
                      <div className="prod-id">{dateOnly(payment.createdAt)}</div>
                    </td>
                    <td><span className="badge badge-info">{payment.paymentType}</span></td>
                    <td>{payment.cashierName || '-'}</td>
                    <td>
                      <span className={`badge ${String(payment.status || '').toLowerCase() === 'voided' ? 'badge-danger' : 'badge-success'}`}>
                        {payment.status || 'completed'}
                      </span>
                    </td>
                    <td>{payment.referenceNumber || <span className="muted">No reference</span>}</td>
                    <td><strong>{peso(payment.amount)}</strong></td>
                    <td>{peso(payment.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredPayments.length > visiblePayments.length && (
              <div className="table-more-row">
                <button className="btn btn-outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                  Show More ({filteredPayments.length - visiblePayments.length} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && <div className="toast"><IconWallet size={15} /> {toast}</div>}
    </>
  )
}
