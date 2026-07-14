import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import DonutChart from '../components/charts/DonutChart'
import LineChart from '../components/charts/LineChart'
import { IconAlert, IconBox, IconCheck, IconCloud, IconDownload, IconPlus, IconScan } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'

const emptyDashboard = {
  stats: { dailySales: 0, monthlySales: 0, totalRevenue: 0, criticalStock: 0, transactionCount: 0, averageSale: 0, cashSales: 0, gcashSales: 0 },
  criticalAlerts: [], topProducts: [], topCategories: [], dailySales: [], inventoryHealth: [], paymentBreakdown: [], recentTransactions: [],
  dataQuality: { generatedBarcodes: 0, uncategorized: 0, nonPositivePrices: 0 }, analyticsMeta: {},
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { data: readiness, setData: setReadiness } = useApi(api.offlineReadiness, {})
  const [data, setData] = useState(emptyDashboard)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [source, setSource] = useState('live')
  const [range, setRange] = useState('30')
  const [refreshingReadiness, setRefreshingReadiness] = useState(false)
  const [readinessMessage, setReadinessMessage] = useState('')

  async function refreshOfflineReadiness() {
    setRefreshingReadiness(true)
    setReadinessMessage('')
    try {
      await api.downloadOfflineData()
      const test = await api.offlineSelfTest()
      localStorage.setItem('nexa_offline_self_test', JSON.stringify(test))
      setReadiness(await api.offlineReadiness())
      setReadinessMessage(test.passed ? 'Offline data refreshed and self-test passed.' : 'Refresh completed, but offline setup still needs attention.')
    } catch (refreshError) {
      setReadinessMessage(refreshError.message || 'Unable to refresh offline data.')
    } finally {
      setRefreshingReadiness(false)
    }
  }

  useEffect(() => {
    let active = true
    const now = new Date()
    const from = new Date(now)
    if (range !== 'all') from.setDate(from.getDate() - (Number(range) - 1))
    const filters = { source, from: range === 'all' ? '' : from.toISOString().slice(0, 10), to: range === 'all' ? '' : now.toISOString().slice(0, 10) }
    void api.dashboard(filters)
      .then((result) => {
        if (!active) return
        setData(result)
        setError('')
        setLoading(false)
        void api.dashboard({ ...filters, preferCloud: true })
          .then((freshResult) => { if (active) setData(freshResult) })
          .catch(() => {})
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || 'Unable to load dashboard.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [range, source])

  if (loading) return <PageLoader title="Dashboard" message="Loading dashboard data…" />
  if (error) return <><PageHeader title="Dashboard" subtitle="Operational overview." /><div className="card"><div className="empty"><h4>Unable to load dashboard</h4><p>{error}</p></div></div></>

  const stats = data.stats || emptyDashboard.stats
  const healthTotal = (data.inventoryHealth || []).reduce((sum, item) => sum + Number(item.value || 0), 0)
  const qualityTotal = Object.values(data.dataQuality || {}).reduce((sum, value) => sum + Number(value || 0), 0)
  const offlineTest = (() => {
    try { return JSON.parse(localStorage.getItem('nexa_offline_self_test') || 'null') }
    catch { return null }
  })()
  const terminalReady = Boolean(readiness?.ready && offlineTest?.passed)

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live operations, sales, inventory health, and actions requiring attention." />

      <div className="card dashboard-control-bar">
        <select className="select" value={source} onChange={(event) => setSource(event.target.value)}><option value="live">Live POS</option><option value="legacy">Legacy Import</option><option value="sample">Sample/Test</option><option value="all">All Sources</option></select>
        <select className="select" value={range} onChange={(event) => setRange(event.target.value)}><option value="1">Today</option><option value="7">Last 7 Days</option><option value="30">Last 30 Days</option><option value="all">All Time</option></select>
        <span className="count">{data.analyticsMeta?.salesCount || 0} matching transactions</span>
        <button className="btn btn-outline" onClick={() => navigate('/admin/products')}><IconPlus size={15} /> New Product</button>
        <button className="btn btn-outline" onClick={() => navigate('/admin/inventory')}><IconScan size={15} /> Stock In / Out</button>
        <button className="btn btn-primary" onClick={() => api.syncNow().then(() => window.location.reload())}><IconCloud size={15} /> Sync Now</button>
      </div>

      <div className="dashboard-kpi-grid">
        {[
          ['Today’s Sales', peso(stats.dailySales), 'Compared with yesterday'],
          ['Transactions', Number(stats.transactionCount || 0).toLocaleString(), 'Selected source and range'],
          ['Average Sale', peso(stats.averageSale), 'Revenue per transaction'],
          ['Cash Sales', peso(stats.cashSales), 'Selected source and range'],
          ['GCash Sales', peso(stats.gcashSales), 'Selected source and range'],
          ['Critical / Out', Number(stats.criticalStock || 0).toLocaleString(), 'Products needing attention'],
        ].map(([label, value, detail]) => <button className="dashboard-kpi" key={label} onClick={() => label.includes('Critical') && navigate('/admin/products')}><span>{label}</span><strong>{value}</strong><small>{detail}</small></button>)}
      </div>

      <div className="dashboard-action-grid">
        <button className="dashboard-attention warning" onClick={() => navigate('/admin/inventory')}><IconAlert size={20} /><span><strong>{stats.criticalStock || 0} stock alerts</strong><small>Review low, critical, and out-of-stock products</small></span></button>
        <button className="dashboard-attention" onClick={() => navigate('/admin/products')}><IconBox size={20} /><span><strong>{qualityTotal} data-quality warnings</strong><small>{data.dataQuality?.generatedBarcodes || 0} generated barcodes · {data.dataQuality?.uncategorized || 0} uncategorized · {data.dataQuality?.nonPositivePrices || 0} price issues</small></span></button>
        <button className={`dashboard-attention ${readiness?.failed ? 'danger' : ''}`} onClick={() => navigate('/admin/settings')}><IconCloud size={20} /><span><strong>{readiness?.failed || 0} failed · {readiness?.pending || 0} pending sync</strong><small>Last sync: {readiness?.lastDownloadAt ? new Date(readiness.lastDownloadAt).toLocaleString('en-PH') : 'Not recorded'}</small></span></button>
      </div>

      <section className={`card dashboard-readiness ${terminalReady ? 'ready' : 'attention'}`}>
        <div className="dashboard-readiness-head">
          <span className="dashboard-readiness-icon">{terminalReady ? <IconCheck size={20} /> : <IconAlert size={20} />}</span>
          <div><h3>Terminal Readiness</h3><p>{terminalReady ? 'This terminal is prepared to continue during a network interruption.' : 'Complete the offline setup before relying on this terminal without internet.'}</p></div>
          <span className="dashboard-readiness-badge">{terminalReady ? 'Ready for Offline Use' : 'Needs Attention'}</span>
        </div>
        <div className="dashboard-readiness-metrics">
          <div><span>Terminal</span><strong>{readiness?.terminalName || 'This terminal'}</strong></div>
          <div><span>Cached catalog</span><strong>{Number(readiness?.cashierProducts || 0).toLocaleString()} products</strong></div>
          <div><span>Cashier access</span><strong>{readiness?.offlineCashierBarcodeLogins || 0} barcode · {readiness?.offlineCashierPasswordLogins || 0} password</strong></div>
          <div><span>Manager approvals</span><strong>{readiness?.managerApprovals || 0} methods</strong></div>
          <div><span>Sync queue</span><strong className={readiness?.failed ? 'readiness-danger' : ''}>{readiness?.pending || 0} pending · {readiness?.failed || 0} failed</strong></div>
          <div><span>Last successful sync</span><strong>{readiness?.lastDownloadAt ? new Date(readiness.lastDownloadAt).toLocaleString('en-PH') : 'Not recorded'}</strong></div>
        </div>
        <div className="dashboard-readiness-actions">
          {readinessMessage && <span className={terminalReady ? 'success' : ''}>{readinessMessage}</span>}
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/admin/settings?tab=offline')}>View Offline Readiness</button>
          <button className="btn btn-primary btn-sm" onClick={refreshOfflineReadiness} disabled={refreshingReadiness}><IconDownload size={15} /> {refreshingReadiness ? 'Refreshing…' : 'Refresh Offline Data'}</button>
        </div>
      </section>

      <div className="dashboard-main-grid">
        <div className="card"><div className="panel-head"><div><h3>Inventory Health</h3><span className="sub">Distribution across {healthTotal.toLocaleString()} products</span></div></div><div className="panel-body"><DonutChart data={data.inventoryHealth || []} centerLabel="Products" /></div></div>
        <div className="card"><div className="panel-head"><div><h3>Sales — Last 7 Days</h3><span className="sub">Live revenue trend (PHP)</span></div><button className="btn btn-outline btn-sm" onClick={() => navigate('/admin/analytics')}>Open Analytics</button></div><div className="panel-body"><LineChart data={data.dailySales || []} color="#4f46e5" /></div></div>
      </div>

      <div className="dashboard-three-grid">
        <div className="card"><div className="panel-head"><h3>Recent Transactions</h3><button className="btn btn-outline btn-sm" onClick={() => navigate('/admin/transaction-logs')}>View All</button></div><div className="panel-body compact-list">{(data.recentTransactions || []).length ? data.recentTransactions.map((sale) => <button key={sale.id} onClick={() => navigate('/admin/transaction-logs')}><span><strong>{sale.transactionNo}</strong><small>{new Date(sale.createdAt).toLocaleString('en-PH')} · {String(sale.paymentMethod).toUpperCase()}</small></span><b>{peso(sale.amount)}</b></button>) : <div className="empty"><h4>No matching transactions</h4></div>}</div></div>
        <div className="card"><div className="panel-head"><h3>Top Products</h3><span className="sub">Units sold</span></div><div className="panel-body compact-list">{(data.topProducts || []).map((item, index) => <button key={item.id || item.name} onClick={() => navigate('/admin/analytics')}><span><strong>{index + 1}. {item.name}</strong><small>{item.category || 'Uncategorized'}</small></span><b>{item.units}</b></button>)}</div></div>
        <div className="card"><div className="panel-head"><h3>Top Categories</h3><span className="sub">Units sold</span></div><div className="panel-body compact-list">{(data.topCategories || []).map((item, index) => <button key={item.name} onClick={() => navigate('/admin/analytics')}><span><strong>{index + 1}. {item.name}</strong></span><b>{item.units}</b></button>)}</div></div>
      </div>
    </>
  )
}
