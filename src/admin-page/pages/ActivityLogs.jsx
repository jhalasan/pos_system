import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import { IconDownload, IconList } from '../components/Icons'
import { activityLogs } from '../data/mockData'

const actionBadge = {
  Login: 'badge-info',
  Logout: 'badge-neutral',
  Sale: 'badge-success',
  Product: 'badge-neutral',
  Inventory: 'badge-warning',
  Sync: 'badge-info',
  'Transaction Void': 'badge-danger',
  Discount: 'badge-success',
  'Stock Update': 'badge-warning',
  'Password Reset': 'badge-info',
  'Cloud Sync': 'badge-info',
}

export default function ActivityLogs() {
  const [userType, setUserType] = useState('All')
  const [action, setAction] = useState('All')
  const [dateRange, setDateRange] = useState('Today')

  const actionTypes = [...new Set(activityLogs.map((l) => l.action))]

  const getDateRange = (range) => {
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

  const selectedRange = getDateRange(dateRange)

  const filtered = useMemo(() => {
    return activityLogs.filter((l) => {
      const mu = userType === 'All' || l.userType === userType
      const ma = action === 'All' || l.action === action
      const dt = new Date(l.time.replace(' ', 'T'))
      const md = !selectedRange.start || (dt >= selectedRange.start && dt <= selectedRange.end)
      return mu && ma && md
    })
  }, [userType, action, selectedRange, dateRange])

  return (
    <>
      <PageHeader
        title="Activity Logs"
        subtitle="Real-time audit trail of all system activities."
      >
        <button className="btn btn-outline" onClick={() => alert('Exporting activity logs…')}>
          <IconDownload size={16} /> Export Logs
        </button>
      </PageHeader>

      <div className="card activity-card">
        <div className="toolbar activity-toolbar">
          <div className="field" style={{ width: 180 }}>
            <select className="select" value={userType} onChange={(e) => setUserType(e.target.value)}>
              <option value="All">All User Types</option>
              <option value="Admin">Admin</option>
              <option value="Cashier">Cashier</option>
            </select>
          </div>
          <div className="field" style={{ width: 180 }}>
            <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="All">All Action Types</option>
              {actionTypes.map((a) => <option key={a}>{a}</option>)}
            </select>
          </div>
          <div className="field" style={{ width: 180 }}>
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
                    <td className="mono">{l.time}</td>
                    <td className="prod-name">{l.user}</td>
                    <td>
                      <span className={'badge ' + (l.userType === 'Admin' ? 'badge-info' : 'badge-neutral')}>
                        {l.userType}
                      </span>
                    </td>
                    <td>
                      <span className={'badge ' + (actionBadge[l.action] || 'badge-neutral')}>
                        {l.action}
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
    </>
  )
}
