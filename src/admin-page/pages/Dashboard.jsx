import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import DonutChart from '../components/charts/DonutChart'
import { IconPeso, IconRevenue, IconAlert } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

const emptyDashboard = {
  stats: {
    dailySales: 0,
    dailySalesTrend: 0,
    monthlySales: 0,
    monthlySalesTrend: 0,
    totalRevenue: 0,
    totalRevenueTrend: 0,
    criticalStock: 0,
  },
  criticalAlerts: [],
  productInOut: [],
  topProducts: [],
}

export default function Dashboard() {
  const { data, loading, error } = useApi(api.dashboard, emptyDashboard)
  const dashboardStats = data.stats
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units))

  if (loading) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Loading dashboard data..." />
        <div className="card"><div className="empty"><h4>Loading dashboard</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Overview of today's sales, revenue, and stock health." />
        <div className="card"><div className="empty"><h4>Unable to load dashboard</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of today's sales, revenue, and stock health."
      />

      <div className="stat-grid">
        <StatCard
          label="Daily Sales" tone="indigo" icon={IconPeso}
          value={peso(dashboardStats.dailySales)}
          trend={dashboardStats.dailySalesTrend} foot="vs. yesterday"
        />
        <StatCard
          label="Monthly Sales" tone="blue" icon={IconPeso}
          value={peso(dashboardStats.monthlySales)}
          trend={dashboardStats.monthlySalesTrend} foot="vs. last month"
        />
        <StatCard
          label="Total Revenue" tone="green" icon={IconRevenue}
          value={peso(dashboardStats.totalRevenue)}
          trend={dashboardStats.totalRevenueTrend} foot="all time"
        />
        <StatCard
          label="Critical Stock" tone="red" icon={IconAlert}
          value={dashboardStats.criticalStock}
          foot="items need restocking"
        />
      </div>

      <div className="alert-banner">
        <span className="ab-icon"><IconAlert size={20} /></span>
        <div>
          <h4>Critical Stock Alerts</h4>
          <div className="ab-list">
            {data.criticalAlerts.length === 0 ? (
              <span className="alert-pill">No critical stock items</span>
            ) : data.criticalAlerts.map((a) => (
              <span className="alert-pill" key={a.name}>
                {a.name} - <b>{a.left} left</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2-wide">
        <div className="card">
          <div className="panel-head">
            <h3>Product In / Out</h3>
            <span className="sub">Stock movement this month</span>
          </div>
          <div className="panel-body">
            <DonutChart data={data.productInOut} centerLabel="Total Units" />
          </div>
        </div>

        <div className="card">
          <div className="panel-head">
            <h3>Top Products</h3>
            <span className="sub">By units sold</span>
          </div>
          <div className="panel-body">
            {data.topProducts.length === 0 ? (
              <div className="empty"><h4>No sales data yet</h4><p>Top products will appear after sales are recorded.</p></div>
            ) : (
              <div className="rank-list">
                {data.topProducts.map((p, i) => (
                  <div className="rank-row" key={p.name}>
                    <span className="rank-no">{i + 1}</span>
                    <div className="rank-info">
                      <div className="rn">{p.name}</div>
                      <div className="rc">{p.category}</div>
                      <div className="rank-bar">
                        <i style={{ width: `${(p.units / maxUnits) * 100}%` }} />
                      </div>
                    </div>
                    <span className="rank-val">{p.units}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
