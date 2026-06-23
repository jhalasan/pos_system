import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import { IconDownload, IconPeso, IconSearch, IconWallet } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'

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
  return value ? new Date(value).toISOString().slice(0, 10) : ''
}

export default function GCashPayments() {
  const { data: payments, loading, error } = useApi(api.gcashPayments, [])
  const [query, setQuery] = useState('')
  const [type, setType] = useState('All')
  const [toast, setToast] = useState('')

  const filteredPayments = useMemo(() => {
    const search = query.trim().toLowerCase()
    return payments.filter((payment) => {
      const typeMatches = type === 'All' || payment.paymentType === type
      const queryMatches = !search || [
        payment.transactionNo,
        payment.referenceNumber,
        payment.cashierName,
      ].some((value) => String(value || '').toLowerCase().includes(search))
      return typeMatches && queryMatches
    })
  }, [payments, query, type])

  const totalAmount = filteredPayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
  const directTotal = filteredPayments
    .filter((payment) => payment.paymentType === 'GCash')
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
  const splitTotal = filteredPayments
    .filter((payment) => payment.paymentType === 'Split')
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)

  async function handleExport() {
    const result = await exportCsv(`gcash-payments-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Date', 'Transaction No.', 'Type', 'Cashier', 'GCash Amount', 'Reference No.', 'Sale Total', 'Cash Portion'],
      ...filteredPayments.map((payment) => [
        formatDate(payment.createdAt),
        payment.transactionNo,
        payment.paymentType,
        payment.cashierName,
        Number(payment.amount) || 0,
        payment.referenceNumber || '',
        Number(payment.totalAmount) || 0,
        Number(payment.cashAmount) || 0,
      ]),
    ], { directory: getExportLocation(exportLocationKeys.analytics) })
    setToast(`GCash payments exported to ${result.path}`)
    window.setTimeout(() => setToast(''), 2400)
  }

  if (loading) {
    return (
      <>
        <PageHeader title="GCash Payments" subtitle="Loading GCash payment records..." />
        <div className="card"><div className="empty"><h4>Loading GCash payments</h4></div></div>
      </>
    )
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
      <PageHeader title="GCash Payments" subtitle="Reconcile GCash amounts, transaction numbers, and reference numbers.">
        <button className="btn btn-outline" onClick={handleExport} disabled={filteredPayments.length === 0}>
          <IconDownload size={16} /> Export
        </button>
      </PageHeader>

      <div className="grid-3" style={{ marginBottom: 18 }}>
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
          <div className="table-tools">
            <div className="input-search">
              <IconSearch size={16} />
              <input
                className="input"
                placeholder="Search transaction, ref, cashier..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select className="select" value={type} onChange={(event) => setType(event.target.value)}>
              <option>All</option>
              <option>GCash</option>
              <option>Split</option>
            </select>
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
                  <th>Reference No.</th>
                  <th>GCash Amount</th>
                  <th>Sale Total</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayments.map((payment) => (
                  <tr key={`${payment.id}-${payment.paymentType}`}>
                    <td>{formatDate(payment.createdAt)}</td>
                    <td>
                      <div className="prod-name">{payment.transactionNo}</div>
                      <div className="prod-id">{dateOnly(payment.createdAt)}</div>
                    </td>
                    <td><span className="badge badge-info">{payment.paymentType}</span></td>
                    <td>{payment.cashierName || '-'}</td>
                    <td>{payment.referenceNumber || <span className="muted">No reference</span>}</td>
                    <td><strong>{peso(payment.amount)}</strong></td>
                    <td>{peso(payment.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && <div className="toast"><IconWallet size={15} /> {toast}</div>}
    </>
  )
}
