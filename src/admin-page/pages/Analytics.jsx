import PageHeader from '../components/PageHeader'
import DonutChart from '../components/charts/DonutChart'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { IconAlert, IconChart, IconDownload, IconTag } from '../components/Icons'
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
  const { data: fsnProducts } = useApi(api.fsnInventory, [])
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [analyticsTab, setAnalyticsTab] = useState('sales')
  const [salesRange, setSalesRange] = useState('dailySales')
  const [selectedFsn, setSelectedFsn] = useState('Fast-moving')
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units))
  const activeSalesRange = salesRanges[salesRange] || salesRanges.hourlySales
  const activeSalesData = data[salesRange] || []
  const fastProducts = fsnProducts.filter((p) => p.fsn === 'Fast-moving')
  const slowProducts = fsnProducts.filter((p) => p.fsn === 'Slow-moving')
  const nonMovingProducts = fsnProducts.filter((p) => p.fsn === 'Non-moving')
  const selectedFsnProducts = selectedFsn === 'Fast-moving'
    ? fastProducts
    : selectedFsn === 'Slow-moving'
      ? slowProducts
      : nonMovingProducts

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
        ...fsnProducts.map((item) => ['Inventory Movement', item.name, `${item.fsn} - ${item.units90 || 0} sold in 90 days`]),
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

      <div className="scan-mode-row analytics-tabs" role="tablist" aria-label="Analytics sections">
        <button
          type="button"
          className={`scan-mode ${analyticsTab === 'sales' ? 'active' : ''}`}
          onClick={() => setAnalyticsTab('sales')}
          role="tab"
          aria-selected={analyticsTab === 'sales'}
        >
          Sales Analytics
        </button>
        <button
          type="button"
          className={`scan-mode ${analyticsTab === 'movement' ? 'active' : ''}`}
          onClick={() => setAnalyticsTab('movement')}
          role="tab"
          aria-selected={analyticsTab === 'movement'}
        >
          Inventory Movement
        </button>
      </div>

      {analyticsTab === 'sales' && (
        <>
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
      )}

      {analyticsTab === 'movement' && (
        <div className="card fsn-card-panel">
          <div className="panel-head">
            <div>
              <h3>Inventory Movement</h3>
              <span className="sub">FSN analysis based on 90-day sales velocity and days since last sale.</span>
            </div>
          </div>
          <div className="panel-body fsn-grid-wrap">
            <div className="fsn-grid">
              <button type="button" className={`fsn-card ${selectedFsn === 'Fast-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Fast-moving')}>
                <div className="fsn-card-top">
                  <div className="fsn-label">Fast-moving</div>
                  <div className="fsn-icon ic-green"><IconChart size={18} /></div>
                </div>
                <div className="fsn-value">{fastProducts.length}</div>
                <div className="fsn-foot">Sold often in the last 90 days</div>
              </button>
              <button type="button" className={`fsn-card ${selectedFsn === 'Slow-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Slow-moving')}>
                <div className="fsn-card-top">
                  <div className="fsn-label">Slow-moving</div>
                  <div className="fsn-icon ic-amber"><IconTag size={18} /></div>
                </div>
                <div className="fsn-value">{slowProducts.length}</div>
                <div className="fsn-foot">Sold recently, but at low velocity</div>
              </button>
              <button type="button" className={`fsn-card ${selectedFsn === 'Non-moving' ? 'active' : ''}`} onClick={() => setSelectedFsn('Non-moving')}>
                <div className="fsn-card-top">
                  <div className="fsn-label">Non-moving</div>
                  <div className="fsn-icon ic-red"><IconAlert size={18} /></div>
                </div>
                <div className="fsn-value">{nonMovingProducts.length}</div>
                <div className="fsn-foot">No sales for 90+ days or never sold</div>
              </button>
            </div>

            <div className="fsn-product-list">
              <div className="fsn-product-list-head">
                <div>{selectedFsn} Products</div>
                <span>{selectedFsnProducts.length} items</span>
              </div>
              {selectedFsnProducts.length === 0 ? (
                <div className="empty">
                  <h4>No {selectedFsn.toLowerCase()} products</h4>
                  <p>Products will appear here once movement data is available.</p>
                </div>
              ) : (
                selectedFsnProducts.map((p) => (
                  <div key={p.id} className="fsn-product-row">
                    <div>
                      <strong>{p.name}</strong>
                      <span>{p.fsnReason} | avg. {(Number(p.averageMonthlyUnits) || 0).toFixed(1)} unit(s)/month</span>
                    </div>
                    <div className="fsn-product-tags">
                      <span className={`badge ${selectedFsn === 'Fast-moving' ? 'badge-info' : selectedFsn === 'Slow-moving' ? 'badge-warning' : 'badge-danger'}`}>
                        {p.units90 || 0} sold
                      </span>
                      <span className="badge badge-neutral">{p.qty} stock</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
