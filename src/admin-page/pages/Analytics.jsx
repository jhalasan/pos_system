import PageHeader from '../components/PageHeader'
import DonutChart from '../components/charts/DonutChart'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { IconDownload } from '../components/Icons'
import { api } from '../services/api'
import { useApi } from '../hooks/useApi'

const emptyAnalytics = {
  productInOut: [],
  topProducts: [],
  hourlySales: [],
  monthlySales: [],
}

export default function Analytics() {
  const { data, loading, error } = useApi(api.dashboard, emptyAnalytics)
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units))

  if (loading) {
    return (
      <>
        <PageHeader title="Analytics" subtitle="Loading analytics..." />
        <div className="card"><div className="empty"><h4>Loading analytics</h4></div></div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title="Analytics" subtitle="Sales trends, product movement, and performance insights." />
        <div className="card"><div className="empty"><h4>Unable to load analytics</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Sales trends, product movement, and performance insights."
      >
        <button className="btn btn-outline" onClick={() => alert('Exporting analytics report...')}>
          <IconDownload size={16} /> Export Report
        </button>
      </PageHeader>

      <div className="grid-2-wide" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="panel-head">
            <h3>Product In / Out</h3>
            <span className="sub">Stock movement</span>
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
                      <div className="rank-bar"><i style={{ width: `${(p.units / maxUnits) * 100}%` }} /></div>
                    </div>
                    <span className="rank-val">{p.units}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          <h3>Hourly Sales</h3>
          <span className="sub">Revenue per hour - today (PHP)</span>
        </div>
        <div className="panel-body">
          {data.hourlySales.length === 0 ? (
            <div className="empty"><h4>No hourly sales yet</h4></div>
          ) : (
            <BarChart data={data.hourlySales} color="#4f46e5" unit=" PHP" />
          )}
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <h3>Monthly Sales</h3>
          <span className="sub">Revenue trend - last 8 months (PHP)</span>
        </div>
        <div className="panel-body">
          {data.monthlySales.length === 0 ? (
            <div className="empty"><h4>No monthly sales yet</h4></div>
          ) : (
            <LineChart data={data.monthlySales} color="#16a34a" />
          )}
        </div>
      </div>
    </>
  )
}
