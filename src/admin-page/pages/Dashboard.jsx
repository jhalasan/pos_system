import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import DonutChart from '../components/charts/DonutChart'
import { IconDollar, IconCalendar, IconRevenue, IconAlert } from '../components/Icons'
import {
  dashboardStats, criticalAlerts, productInOut, topProducts, peso,
} from '../data/mockData'

export default function Dashboard() {
  const maxUnits = Math.max(...topProducts.map((p) => p.units))

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of today's sales, revenue, and stock health."
      />

      <div className="stat-grid">
        <StatCard
          label="Daily Sales" tone="indigo" icon={IconDollar}
          value={peso(dashboardStats.dailySales)}
          trend={dashboardStats.dailySalesTrend} foot="vs. yesterday"
        />
        <StatCard
          label="Monthly Sales" tone="blue" icon={IconCalendar}
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
            {criticalAlerts.map((a) => (
              <span className="alert-pill" key={a.name}>
                {a.name} — <b>{a.left} left</b>
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
            <DonutChart data={productInOut} centerLabel="Total Units" />
          </div>
        </div>

        <div className="card">
          <div className="panel-head">
            <h3>Top Products</h3>
            <span className="sub">By units sold</span>
          </div>
          <div className="panel-body">
            <div className="rank-list">
              {topProducts.map((p, i) => (
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
          </div>
        </div>
      </div>
    </>
  )
}
