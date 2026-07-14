import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import DonutChart from '../components/charts/DonutChart'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { IconAlert, IconChart, IconDownload, IconTag } from '../components/Icons'
import { api } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { peso } from '../services/api'

const emptyAnalytics = {
  stats: { totalRevenue: 0, transactionCount: 0, averageSale: 0, cashSales: 0, gcashSales: 0, unitsSold: 0, voidCount: 0 },
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
  const navigate = useNavigate()
  const { data, setData, loading, error } = useApi(api.dashboard, emptyAnalytics)
  const { data: fsnProducts } = useApi(api.fsnInventory, [])
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [analyticsTab, setAnalyticsTab] = useState('sales')
  const [salesRange, setSalesRange] = useState('dailySales')
  const [selectedFsn, setSelectedFsn] = useState('Fast-moving')
  const [dataSource, setDataSource] = useState('live')
  const [datePreset, setDatePreset] = useState('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')

  useEffect(() => {
    const now = new Date()
    const fromDate = new Date(now)
    if (datePreset !== 'all' && datePreset !== 'custom') fromDate.setDate(fromDate.getDate() - (Number(datePreset) - 1))
    const filters = {
      source: dataSource,
      from: datePreset === 'custom' ? customFrom : (datePreset === 'all' ? '' : fromDate.toISOString().slice(0, 10)),
      to: datePreset === 'custom' ? customTo : (datePreset === 'all' ? '' : now.toISOString().slice(0, 10)),
    }
    void api.dashboard(filters).then((result) => {
      setData(result)
      setLastUpdated(new Date().toISOString())
    })
  }, [customFrom, customTo, dataSource, datePreset, setData])
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
  const stats = data.stats || emptyAnalytics.stats
  const sourceLabel = { live: 'Live POS', legacy: 'Legacy Import', sample: 'Sample/Test', all: 'All Sources' }[dataSource]
  const rangeLabel = datePreset === 'custom'
    ? `${customFrom || 'Start'} to ${customTo || 'Today'}`
    : ({ 1: 'Today', 7: 'Last 7 Days', 30: 'Last 30 Days', all: 'All Time' }[datePreset] || 'Selected Range')
  const salesTrend = datePreset === '1' ? stats.dailySalesTrend : datePreset === '30' ? stats.monthlySalesTrend : null

  async function exportReport() {
    setExporting(true)
    setExportStatus('Exporting...')
    try {
      const safeScope = `${dataSource}-${datePreset === 'custom' ? `${customFrom || 'start'}-${customTo || 'today'}` : datePreset}`
      const result = await exportCsv(`analytics-${analyticsTab}-${safeScope}-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Filters', 'Data source', sourceLabel],
        ['Filters', 'Date range', rangeLabel],
        ['KPI', 'Gross sales', stats.totalRevenue],
        ['KPI', 'Transactions', stats.transactionCount],
        ['KPI', 'Average sale', stats.averageSale],
        ['KPI', 'Units sold', stats.unitsSold],
        ['KPI', 'Voided transactions', stats.voidCount],
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
    return <PageLoader title="Analytics" message="Loading analytics…" />
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

      <div className="scan-mode-row analytics-tabs analytics-tabs-sticky" role="tablist" aria-label="Analytics sections">
        <button type="button" className={`scan-mode ${analyticsTab === 'sales' ? 'active' : ''}`} onClick={() => setAnalyticsTab('sales')} role="tab" aria-selected={analyticsTab === 'sales'}>Sales Analytics</button>
        <button type="button" className={`scan-mode ${analyticsTab === 'movement' ? 'active' : ''}`} onClick={() => setAnalyticsTab('movement')} role="tab" aria-selected={analyticsTab === 'movement'}>Inventory Movement</button>
      </div>

      <div className="card analytics-filter-card">
        <div className="toolbar">
          <select className="select" value={dataSource} onChange={(event) => setDataSource(event.target.value)} aria-label="Analytics data source">
            <option value="live">Live POS Data</option>
            <option value="legacy">Legacy Import</option>
            <option value="sample">Sample/Test Data</option>
            <option value="all">All Data Sources</option>
          </select>
          <select className="select" value={datePreset} onChange={(event) => setDatePreset(event.target.value)} aria-label="Analytics date range">
            <option value="1">Today</option>
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="all">All Time</option>
            <option value="custom">Custom Range</option>
          </select>
          {datePreset === 'custom' && <input className="input" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />}
          {datePreset === 'custom' && <input className="input" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />}
          <span className="count">{data.analyticsMeta?.salesCount || 0} matching sale(s)</span>
          <span className="analytics-filter-summary">{sourceLabel} · {rangeLabel}</span>
          <button className="btn btn-outline btn-sm" onClick={() => { void api.dashboard({ source: dataSource, from: data.analyticsMeta?.from || '', to: data.analyticsMeta?.to || '' }).then((result) => { setData(result); setLastUpdated(new Date().toISOString()) }) }}>Refresh</button>
        </div>
      </div>

      <div className="analytics-kpi-grid">
        {[
          ['Gross Sales', peso(stats.totalRevenue), salesTrend, 'Revenue in selected range'],
          ['Transactions', Number(stats.transactionCount || 0).toLocaleString(), null, 'Completed sales'],
          ['Average Sale', peso(stats.averageSale), null, 'Revenue per transaction'],
          ['Units Sold', Number(stats.unitsSold || 0).toLocaleString(), null, 'Across all products'],
          ['Cash Sales', peso(stats.cashSales), null, 'Cash payments'],
          ['GCash Sales', peso(stats.gcashSales), null, `${stats.voidCount || 0} voided transaction(s)`],
        ].map(([label, value, comparison, detail]) => <div className="analytics-kpi" key={label}><span>{label}</span><strong>{value}</strong>{comparison !== null && <b className={comparison >= 0 ? 'up' : 'down'}>{comparison >= 0 ? '▲' : '▼'} {Math.abs(comparison)}% vs previous period</b>}<small>{detail}</small></div>)}
      </div>

      <div className="analytics-update-line">Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleString('en-PH') : 'Not recorded'}</div>

      {analyticsTab === 'sales' && (
        <>
          <div className="grid-2-wide analytics-overview" style={{ marginBottom: 18 }}>
            <div className="card compact-chart-card">
              <div className="panel-head">
                <h3>Inventory Position / Sales</h3>
                <span className="sub">Current stock and units sold in the selected range</span>
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
                  <div className="empty analytics-empty"><h4>No sales in the selected period</h4><p>Try a wider date range or include another data source.</p><div><button className="btn btn-outline btn-sm" onClick={() => setDatePreset('all')}>Expand Date Range</button><button className="btn btn-outline btn-sm" onClick={() => setDataSource('all')}>View All Sources</button><button className="btn btn-primary btn-sm" onClick={() => navigate('/admin/transaction-logs')}>Transaction Logs</button></div></div>
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
                <div className="empty analytics-empty"><h4>{activeSalesRange.empty}</h4><p>No matching revenue was recorded for {sourceLabel.toLowerCase()}.</p><div><button className="btn btn-outline btn-sm" onClick={() => setDatePreset('all')}>Expand Date Range</button><button className="btn btn-primary btn-sm" onClick={() => navigate('/admin/transaction-logs')}>View Transactions</button></div></div>
              ) : activeSalesRange.chart === 'bar' ? (
                <BarChart data={activeSalesData} color={activeSalesRange.color} unit=" PHP" />
              ) : (
                <LineChart data={activeSalesData} color={activeSalesRange.color} />
              )}
            </div>
          </div>

          <div className="analytics-detail-grid">
            <div className="card"><div className="panel-head"><h3>Payment Mix</h3><span className="sub">Selected range revenue</span></div><div className="panel-body"><DonutChart data={data.paymentBreakdown || []} centerLabel="Revenue" /></div></div>
            <div className="card"><div className="panel-head"><h3>Top Categories</h3><span className="sub">By units sold</span></div><div className="panel-body compact-list">{(data.topCategories || []).length ? data.topCategories.map((item, index) => <div className="analytics-list-row" key={item.name}><span><strong>{index + 1}. {item.name}</strong><small>{stats.unitsSold ? Math.round((item.units / stats.unitsSold) * 100) : 0}% of units sold</small></span><b>{item.units}</b></div>) : <div className="empty"><h4>No category sales yet</h4></div>}</div></div>
            <div className="card"><div className="panel-head"><h3>Products Needing Attention</h3><span className="sub">Movement-based actions</span></div><div className="panel-body compact-list"><button onClick={() => { setAnalyticsTab('movement'); setSelectedFsn('Slow-moving') }}><span><strong>{slowProducts.length} slow-moving</strong><small>Review pricing or placement</small></span></button><button onClick={() => { setAnalyticsTab('movement'); setSelectedFsn('Non-moving') }}><span><strong>{nonMovingProducts.length} non-moving</strong><small>No sale for 90+ days or never sold</small></span></button><button onClick={() => navigate('/admin/products')}><span><strong>Open product health</strong><small>Review stock and catalog warnings</small></span></button></div></div>
          </div>
        </>
      )}

      {analyticsTab === 'movement' && (
        <div className="card fsn-card-panel">
          <div className="panel-head">
            <div>
              <h3>Inventory Movement</h3>
              <span className="sub">Fast, slow, and non-moving product analysis based on 90-day sales activity.</span>
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
