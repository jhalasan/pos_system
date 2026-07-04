import { useMemo } from 'react'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import { IconDollar, IconList, IconUsers } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

function cashOutAmount(detail = '') {
  const match = String(detail).match(/Cash out PHP\s*([\d,.]+)/i)
  return match ? Number(match[1].replace(/,/g, '')) || 0 : 0
}

function cashierNameFromCashOut(detail = '') {
  const match = String(detail).match(/by\s+(.+?)\s+approved by/i)
  return match?.[1] || 'Cashier'
}

export default function Audit() {
  const { data: receipts, loading: receiptsLoading } = useApi(api.receipts, [])
  const { data: logs, loading: logsLoading } = useApi(api.activityLogs, [])

  const auditRows = useMemo(() => {
    const rows = new Map()
    const ensure = (name) => {
      const key = name || 'Cashier'
      if (!rows.has(key)) {
        rows.set(key, {
          cashierName: key,
          cashBeginning: 0,
          cashSales: 0,
          cashOut: 0,
          cashEnding: 0,
          entries: [],
        })
      }
      return rows.get(key)
    }

    for (const receipt of receipts || []) {
      const method = String(receipt.paymentMethod || '').toLowerCase()
      if (method === 'cash') {
        ensure(receipt.cashierName || 'Cashier').cashSales += Number(receipt.cashAmount || receipt.totalAmount) || 0
      }
      if (method === 'split') {
        ensure(receipt.cashierName || 'Cashier').cashSales += Number(receipt.splitPayments?.cash || receipt.cashAmount) || 0
      }
    }

    for (const log of logs || []) {
      if (log.action !== 'Cash Out') continue
      const name = cashierNameFromCashOut(log.detail)
      const row = ensure(name)
      const amount = cashOutAmount(log.detail)
      row.cashOut += amount
      row.entries.push({ ...log, amount })
    }

    return [...rows.values()].map((row) => ({
      ...row,
      cashEnding: row.cashBeginning + row.cashSales - row.cashOut,
    })).sort((a, b) => a.cashierName.localeCompare(b.cashierName))
  }, [logs, receipts])

  const totalCashOnHand = auditRows.reduce((sum, row) => sum + row.cashEnding, 0)
  const totalCashOut = auditRows.reduce((sum, row) => sum + row.cashOut, 0)

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
      <PageHeader title="Audit" subtitle="Cash beginning, cash sales, cash-outs, and calculated cash on hand by cashier." />

      <div className="stat-grid cols-3">
        <StatCard label="Cashiers" tone="indigo" icon={IconUsers} value={auditRows.length} foot="with cash activity" />
        <StatCard label="Cash On Hand" tone="green" icon={IconDollar} value={peso(totalCashOnHand)} foot="Cash sales less cash-outs" />
        <StatCard label="Cash Out" tone="red" icon={IconList} value={peso(totalCashOut)} foot="Manager-approved removals" />
      </div>

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Cashier Cash Audit</h3>
            <span className="sub">Cash beginning/ending are shown as calculated audit fields for now.</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Cashier</th>
                <th>Cash Beginning</th>
                <th>Cash Sales</th>
                <th>Cash Out</th>
                <th>Cash On Hand / Ending</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((row) => (
                <tr key={row.cashierName}>
                  <td>{row.cashierName}</td>
                  <td>{peso(row.cashBeginning)}</td>
                  <td>{peso(row.cashSales)}</td>
                  <td>{peso(row.cashOut)}</td>
                  <td><strong>{peso(row.cashEnding)}</strong></td>
                </tr>
              ))}
              {auditRows.length === 0 && (
                <tr><td colSpan="5" className="muted">No cash audit activity yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
