import { useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { IconBarcode, IconDownload, IconPrint, IconReceipt, IconSearch } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { printCompletedReceipt, printReceiptPdf } from '../../cashier-pos/services/receiptPrinter'
import GCashPayments from './GCashPayments'

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

function normalizedStatus(record) {
  return String(record.rawStatus || record.status || 'completed').toLowerCase()
}

function filterDates(range, customFrom, customTo) {
  if (range === 'today') return { fromDate: todayDate(), toDate: todayDate() }
  if (range === '7days') return { fromDate: lastDaysDate(6), toDate: todayDate() }
  if (range === 'month') return { fromDate: monthStartDate(), toDate: todayDate() }
  if (range === 'custom') return { fromDate: customFrom, toDate: customTo }
  return { fromDate: '', toDate: '' }
}

function receiptPayment(record) {
  return {
    paymentMethod: record.paymentMethod,
    totalAmount: record.totalAmount,
    subtotalAmount: record.subtotalAmount || record.totalAmount,
    discountPercent: record.discountPercent,
    discountAmount: record.discountAmount,
    cashAmount: record.cashAmount,
    gcashAmount: record.gcashAmount,
    splitPayments: record.splitPayments,
    gcashRef: record.refNumber,
  }
}

function receiptData(record) {
  return {
    transactionNo: record.transactionNo || record.receiptNo,
    cashierName: record.cashierName || 'Cashier',
    completedAt: record.createdAt,
    items: record.items || [],
    payment: receiptPayment(record),
  }
}

function safeFilenamePart(value) {
  return String(value || 'transaction')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function itemCountDisplay(receipt) {
  if (receipt.itemCount !== null && receipt.itemCount !== undefined) return receipt.itemCount
  const items = receipt.items || []
  const counted = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  if (receipt.missingItems) return 'Untracked'
  return counted > 0 ? counted : '-'
}

function paymentBreakdown(receipt) {
  const method = String(receipt.paymentMethod || '').toLowerCase()
  const splitCash = Number(receipt.splitPayments?.cash) || 0
  const splitGcash = Number(receipt.splitPayments?.gcash) || 0
  const total = Number(receipt.totalAmount) || 0
  const cash = method === 'split' ? splitCash : (method === 'cash' ? Number(receipt.cashAmount || total) || 0 : 0)
  const gcash = method === 'split' ? splitGcash : (method === 'gcash' ? Number(receipt.gcashAmount || total) || 0 : 0)
  return {
    cash,
    gcash,
    cashSubtotal: cash,
    gcashSubtotal: gcash,
    total,
  }
}

export default function TransactionLogs() {
  const { data: receipts, loading, error } = useApi(api.receipts, [])
  const { data: cashiers } = useApi(api.cashiers, [])
  const scanInputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [cashierName, setCashierName] = useState('all')
  const [action, setAction] = useState('all')
  const [status, setStatus] = useState('all')
  const [subTab, setSubTab] = useState('transactions')
  const [selectedReceipt, setSelectedReceipt] = useState(null)
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const cashierOptions = useMemo(() => {
    const names = new Set()
    for (const cashier of cashiers || []) {
      if (cashier.name) names.add(cashier.name)
      else if (cashier.email) names.add(cashier.email)
    }
    for (const receipt of receipts || []) {
      if (receipt.cashierName) names.add(receipt.cashierName)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [cashiers, receipts])

  const filteredReceipts = useMemo(() => {
    const search = query.trim().toLowerCase()
    const { fromDate, toDate } = filterDates(dateRange, customFrom, customTo)
    const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
    const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null

    return receipts.filter((receipt) => {
      const created = new Date(receipt.createdAt).getTime()
      const receiptStatus = normalizedStatus(receipt)
      const matchesQuery = !search || [
        receipt.receiptNo,
        receipt.transactionNo,
        receipt.cashierName,
        receipt.paymentMethod,
      ].some((value) => String(value || '').toLowerCase().includes(search))
      const matchesCashier = cashierName === 'all' || receipt.cashierName === cashierName
      const matchesStatus = status === 'all' || receiptStatus === status
      const matchesAction = action === 'all'
        || (action === 'reprintable' && receiptStatus !== 'voided')
        || (action === 'needs-review' && ['voided', 'adjusted'].includes(receiptStatus))
      const matchesDate = (!fromTime || created >= fromTime) && (!toTime || created <= toTime)
      return matchesQuery && matchesCashier && matchesStatus && matchesAction && matchesDate
    })
  }, [action, cashierName, customFrom, customTo, dateRange, query, receipts, status])

  const totalAmount = filteredReceipts.reduce((sum, receipt) => sum + (Number(receipt.totalAmount) || 0), 0)
  const voidedCount = filteredReceipts.filter((receipt) => normalizedStatus(receipt) === 'voided').length
  const visibleReceipts = filteredReceipts.slice(0, visibleCount)

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [action, cashierName, customFrom, customTo, dateRange, query, status, subTab])

  async function handleReprint(receipt) {
    try {
      await printCompletedReceipt(receiptData(receipt))
      setToast(`Reprinted transaction ${receipt.receiptNo || receipt.transactionNo}.`)
      window.setTimeout(() => setToast(''), 2400)
    } catch (err) {
      setToast((typeof err === 'string' ? err : err.message) || 'Unable to reprint receipt.')
      window.setTimeout(() => setToast(''), 3200)
    }
  }

  async function handleDownloadPdf(receipt) {
    try {
      const filename = `${safeFilenamePart(receipt.receiptNo || receipt.transactionNo)}-receipt.pdf`
      const result = await printReceiptPdf(receiptData(receipt), { filename })
      setToast(`Soft copy saved to ${result.path}.`)
      window.setTimeout(() => setToast(''), 2400)
    } catch (err) {
      setToast((typeof err === 'string' ? err : err.message) || 'Unable to download receipt PDF.')
      window.setTimeout(() => setToast(''), 3200)
    }
  }

  async function handleExportTransactions() {
    const result = await exportCsv(`transaction-logs-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Transaction No.', 'Date / Time', 'Cashier', 'Status', 'Items', 'Cash', 'GCash', 'Cash Subtotal', 'GCash Subtotal', 'Total'],
      ...filteredReceipts.map((receipt) => {
        const payment = paymentBreakdown(receipt)
        return [
          receipt.receiptNo || receipt.transactionNo,
          formatDate(receipt.createdAt),
          receipt.cashierName || '',
          receipt.status || 'Completed',
          itemCountDisplay(receipt),
          payment.cash,
          payment.gcash,
          payment.cashSubtotal,
          payment.gcashSubtotal,
          payment.total,
        ]
      }),
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`Transaction sheet exported to ${result.path}.`)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function handleExportTransaction(receipt) {
    const result = await exportCsv(`${safeFilenamePart(receipt.receiptNo || receipt.transactionNo)}-items.csv`, [
      ['Receipt No.', receipt.receiptNo || receipt.transactionNo],
      ['Date / Time', formatDate(receipt.createdAt)],
      ['Cashier', receipt.cashierName || ''],
      ['Status', receipt.status || 'Completed'],
      ['Payment', receipt.paymentMethod || ''],
      [],
      ['Item', 'Barcode', 'Qty', 'Unit Price', 'Amount'],
      ...(receipt.items || []).map((item) => [
        item.name || 'Item',
        item.barcode || '',
        Number(item.quantity) || 0,
        Number(item.price) || 0,
        (Number(item.quantity) || 0) * (Number(item.price) || 0),
      ]),
      [],
      ['Subtotal', '', '', '', Number(receipt.subtotalAmount || receipt.totalAmount) || 0],
      ['Discount', '', '', '', Number(receipt.discountAmount) || 0],
      ['Total', '', '', '', Number(receipt.totalAmount) || 0],
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`Transaction sheet exported to ${result.path}.`)
    window.setTimeout(() => setToast(''), 2400)
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Transaction Logs" subtitle="Loading transaction history..." />
        <div className="card"><div className="empty"><h4>Loading transactions</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Transaction Logs" subtitle="Search transactions by receipt number, cashier, date, action, or status." />
        <div className="card"><div className="empty"><h4>Unable to load transactions</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Transaction Logs" subtitle="All transaction history with receipt-number scan/search, date, cashier, action, and status filters.">
        <button className="btn btn-outline" onClick={handleExportTransactions} disabled={filteredReceipts.length === 0}>
          <IconDownload size={16} /> Export Sheet
        </button>
        <button className="btn btn-outline" onClick={() => scanInputRef.current?.focus()}>
          <IconBarcode size={16} /> Focus Scanner
        </button>
      </PageHeader>

      <div className="scan-mode-row analytics-tabs">
        <button
          type="button"
          className={`scan-mode ${subTab === 'transactions' ? 'active' : ''}`}
          onClick={() => setSubTab('transactions')}
        >
          Transactions
        </button>
        <button
          type="button"
          className={`scan-mode ${subTab === 'gcash' ? 'active' : ''}`}
          onClick={() => setSubTab('gcash')}
        >
          GCash Payments
        </button>
      </div>

      {subTab === 'gcash' ? (
        <GCashPayments embedded sourceReceipts={receipts} />
      ) : (
      <>

      <div className="stat-grid cols-3">
        <StatCard label="Matched Transactions" value={filteredReceipts.length} icon={IconReceipt} tone="indigo" foot={`${receipts.length} total record(s)`} />
        <StatCard label="Matched Sales" value={peso(totalAmount)} icon={IconPrint} tone="green" foot="Filtered total" />
        <StatCard label="Voided" value={voidedCount} icon={IconBarcode} tone="red" foot="Within current filters" />
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="panel-body">
          <div className="receipt-filter-grid compact-filter-grid">
            <div className="field span-2">
              <span>Receipt No. / Barcode Scan</span>
              <div className="input-search">
                <IconSearch size={16} />
                <input
                  ref={scanInputRef}
                  className="input"
                  placeholder="Scan barcode or enter receipt number"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.select()
                  }}
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
            <label className="field">
              <span>Cashier Name</span>
              <select className="select" value={cashierName} onChange={(event) => setCashierName(event.target.value)}>
                <option value="all">All cashiers</option>
                {cashierOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Actions</span>
              <select className="select" value={action} onChange={(event) => setAction(event.target.value)}>
                <option value="all">All actions</option>
                <option value="reprintable">Reprint available</option>
                <option value="needs-review">Needs review</option>
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="completed">Completed</option>
                <option value="voided">Voided</option>
                <option value="adjusted">Adjusted</option>
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
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Transaction History</h3>
            <span className="sub">Includes completed, voided, and adjusted transactions when they are available in sales history.</span>
          </div>
          <span className="muted">{filteredReceipts.length} result(s)</span>
        </div>

        {filteredReceipts.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconReceipt size={24} /></div>
            <h4>No transactions found</h4>
            <p>Scan a receipt barcode or adjust the filters.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data transaction-log-table">
              <thead>
                <tr>
                  <th>Transaction No.</th>
                  <th>Date / Time</th>
                  <th>Cashier</th>
                  <th>Items</th>
                  <th>Details</th>
                  <th>Cash</th>
                  <th>GCash</th>
                  <th>Cash Subtotal</th>
                  <th>GCash Subtotal</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleReceipts.map((receipt) => {
                  const receiptStatus = normalizedStatus(receipt)
                  const payment = paymentBreakdown(receipt)
                  return (
                    <tr
                      key={receipt.id}
                      className="clickable-row"
                      onClick={() => setSelectedReceipt(receipt)}
                      title="Open transaction details"
                    >
                      <td>
                        <div className="prod-name">{receipt.receiptNo || receipt.transactionNo}</div>
                        <div className="prod-id">{receipt.paymentMethod || 'cash'}</div>
                      </td>
                      <td>{formatDate(receipt.createdAt)}</td>
                      <td>{receipt.cashierName || '-'}</td>
                      <td>{itemCountDisplay(receipt)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedReceipt(receipt)
                          }}
                        >
                          Details
                        </button>
                      </td>
                      <td>{payment.cash > 0 ? peso(payment.cash) : '-'}</td>
                      <td>{payment.gcash > 0 ? peso(payment.gcash) : '-'}</td>
                      <td>{peso(payment.cashSubtotal)}</td>
                      <td>{peso(payment.gcashSubtotal)}</td>
                      <td><strong>{peso(payment.total)}</strong></td>
                      <td>
                        <span className={`badge ${receiptStatus === 'voided' ? 'badge-danger' : receiptStatus === 'adjusted' ? 'badge-warning' : 'badge-success'}`}>
                          {receipt.status || 'Completed'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filteredReceipts.length > visibleReceipts.length && (
              <div className="table-more-row">
                <button className="btn btn-outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                  Show More ({filteredReceipts.length - visibleReceipts.length} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedReceipt && (
        <Modal
          title={`Transaction ${selectedReceipt.receiptNo || selectedReceipt.transactionNo}`}
          onClose={() => setSelectedReceipt(null)}
          footer={(
            <>
              <button className="btn btn-outline" onClick={() => handleExportTransaction(selectedReceipt)}>
                <IconDownload size={16} /> Export Sheet
              </button>
              <button className="btn btn-outline" onClick={() => handleDownloadPdf(selectedReceipt)}>
                <IconDownload size={16} /> Download PDF
              </button>
              <button className="btn btn-primary" onClick={() => handleReprint(selectedReceipt)}>
                <IconPrint size={16} /> Print
              </button>
            </>
          )}
        >
          <div className="transaction-detail">
            <div className="transaction-soft-copy">
              <div className="receipt-brand">ARJOV CONSUMER GOODS TRADING</div>
              <div>Aparente Street Ext.</div>
              <div>Purok Malakas Brgy. San Isidro</div>
              <div>General Santos City</div>
              <div className="receipt-title">Sale Receipt</div>
              <div className="receipt-rule" />
              <div className="receipt-meta">
                <span>Receipt No.</span><strong>{selectedReceipt.receiptNo || selectedReceipt.transactionNo}</strong>
                <span>Date</span><strong>{formatDate(selectedReceipt.createdAt)}</strong>
                <span>Cashier</span><strong>{selectedReceipt.cashierName || 'Cashier'}</strong>
                <span>Status</span><strong>{selectedReceipt.status || 'Completed'}</strong>
              </div>
              <div className="receipt-rule" />
              <div className="receipt-items">
                {(selectedReceipt.items || []).length === 0 && (
                  <div className="muted">Item details are not available for this transaction.</div>
                )}
                {(selectedReceipt.items || []).map((item) => (
                  <div className="receipt-item" key={`${item.productId || item.id}-${item.name}`}>
                    <div>
                      <strong>{item.name || 'Item'}</strong>
                      <span>{Number(item.quantity) || 0} {item.unit || 'unit'} x {peso(item.price)}</span>
                    </div>
                    <strong>{peso((Number(item.quantity) || 0) * (Number(item.price) || 0))}</strong>
                  </div>
                ))}
              </div>
              <div className="receipt-rule" />
              <div className="receipt-totals">
                <span>Items</span><strong>{itemCountDisplay(selectedReceipt)}</strong>
                <span>Subtotal</span><strong>{peso(selectedReceipt.subtotalAmount || selectedReceipt.totalAmount)}</strong>
                <span>Cash Subtotal</span><strong>{peso(paymentBreakdown(selectedReceipt).cashSubtotal)}</strong>
                <span>GCash Subtotal</span><strong>{peso(paymentBreakdown(selectedReceipt).gcashSubtotal)}</strong>
                {Number(selectedReceipt.discountAmount) > 0 && (
                  <>
                    <span>Discount</span><strong>-{peso(selectedReceipt.discountAmount)}</strong>
                  </>
                )}
                <span>Total</span><strong>{peso(selectedReceipt.totalAmount)}</strong>
                <span>Cash</span><strong>{peso(paymentBreakdown(selectedReceipt).cash)}</strong>
                <span>GCash</span><strong>{peso(paymentBreakdown(selectedReceipt).gcash)}</strong>
                <span>Payment</span><strong>{selectedReceipt.paymentMethod || 'Cash'}</strong>
              </div>
              <div className="receipt-rule" />
              <div className="receipt-disclaimer">NOT AN OFFICIAL RECEIPT</div>
            </div>
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconPrint size={15} /> {toast}</div>}
      </>
      )}
    </>
  )
}
