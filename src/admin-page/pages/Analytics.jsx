import PageHeader from '../components/PageHeader'
import DonutChart from '../components/charts/DonutChart'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { IconDownload } from '../components/Icons'
import { api } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { useState } from 'react'

const emptyAnalytics = {
  productInOut: [],
  topProducts: [],
  hourlySales: [],
  dailySales: [],
  weeklySales: [],
  monthlySales: [],
  yearlySales: [],
}

const salesRanges = {
  hourlySales: {
    label: 'Hourly Sales',
    subtitle: 'Revenue per hour - today (PHP)',
    empty: 'No hourly sales yet',
    chart: 'bar',
    color: '#4f46e5',
  },
  dailySales: {
    label: 'Daily Sales',
    subtitle: 'Revenue trend - last 7 days (PHP)',
    empty: 'No daily sales yet',
    chart: 'line',
    color: '#4f46e5',
  },
  weeklySales: {
    label: 'Weekly Sales',
    subtitle: 'Revenue trend - last 8 weeks (PHP)',
    empty: 'No weekly sales yet',
    chart: 'line',
    color: '#0891b2',
  },
  monthlySales: {
    label: 'Monthly Sales',
    subtitle: 'Revenue trend - last 8 months (PHP)',
    empty: 'No monthly sales yet',
    chart: 'line',
    color: '#16a34a',
  },
  yearlySales: {
    label: 'Yearly Sales',
    subtitle: 'Revenue trend - last 5 years (PHP)',
    empty: 'No yearly sales yet',
    chart: 'line',
    color: '#9333ea',
  },
}

export default function Analytics() {
  const { data, loading, error } = useApi(api.dashboard, emptyAnalytics)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [salesRange, setSalesRange] = useState('hourlySales')
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units))
  const activeSalesRange = salesRanges[salesRange] || salesRanges.hourlySales
  const activeSalesData = data[salesRange] || []

  async function exportReport() {
    setExporting(true)
    setExportStatus('Exporting...')
    try {
      const result = await exportCsv(`analytics-report-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Section', 'Label', 'Value'],
        ...data.productInOut.map((item) => ['Product In/Out', item.label, item.value]),
        ...data.topProducts.map((item) => ['Top Products', item.name, item.units]),
        ...Object.entries(salesRanges).flatMap(([key, range]) => (
          (data[key] || []).map((item) => [range.label, item.label, item.value])
        )),
      ], { directory: getExportLocation(exportLocationKeys.reports) })
      setExportStatus(`Exported in - "${result.path}"`)
    } catch (err) {
      setExportStatus(err.message || 'Unable to export report.')
    } finally {
      setExporting(false)
    }
  }

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
        <button className="btn btn-outline" onClick={exportReport} disabled={exporting}>
          <IconDownload size={16} /> {exporting ? 'Exporting...' : 'Export Report'}
        </button>
      </PageHeader>
      {exportStatus && <div className="export-status">{exportStatus}</div>}

      <div className="grid-2-wide analytics-overview" style={{ marginBottom: 18 }}>
        <div className="card compact-chart-card">
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
          <div>
            <h3>{activeSalesRange.label}</h3>
            <span className="sub">{activeSalesRange.subtitle}</span>
          </div>
          <select className="select" value={salesRange} onChange={(e) => setSalesRange(e.target.value)}>
            {Object.entries(salesRanges).map(([key, range]) => (
              <option key={key} value={key}>{range.label}</option>
            ))}
          </select>
        </div>
        <div className="panel-body">
          {activeSalesData.length === 0 ? (
            <div className="empty"><h4>{activeSalesRange.empty}</h4></div>
          ) : activeSalesRange.chart === 'bar' ? (
            <BarChart data={activeSalesData} color={activeSalesRange.color} unit=" PHP" />
          ) : (
            <LineChart data={activeSalesData} color={activeSalesRange.color} />
          )}
        </div>
      </div>
    </>
  )
}
