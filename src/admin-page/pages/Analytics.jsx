import PageHeader from '../components/PageHeader'
import DonutChart from '../components/charts/DonutChart'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { IconDownload } from '../components/Icons'
import { productInOut, topProducts, hourlySales, monthlySales } from '../data/mockData'

export default function Analytics() {
  const maxUnits = Math.max(...topProducts.map((p) => p.units))

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Sales trends, product movement, and performance insights."
      >
        <button className="btn btn-outline" onClick={() => alert('Exporting analytics report…')}>
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
                    <div className="rank-bar"><i style={{ width: `${(p.units / maxUnits) * 100}%` }} /></div>
                  </div>
                  <span className="rank-val">{p.units}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          <h3>Hourly Sales</h3>
          <span className="sub">Revenue per hour — today (₱)</span>
        </div>
        <div className="panel-body">
          <BarChart data={hourlySales} color="#4f46e5" unit=" ₱" />
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <h3>Monthly Sales</h3>
          <span className="sub">Revenue trend — last 8 months (₱ thousands)</span>
        </div>
        <div className="panel-body">
          <LineChart data={monthlySales} color="#16a34a" />
        </div>
      </div>
    </>
  )
}
