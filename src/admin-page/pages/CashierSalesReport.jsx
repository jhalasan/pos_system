import { useEffect, useMemo, useState } from 'react'
import { api, peso } from '../services/api'
import { exportCsv, safeFilenamePart } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import {
  resolveReceiptCategories,
  summarizeSalesByProduct,
  summarizeByCategory,
  filterReceiptsByProductCategory,
} from '../utils/receiptSalesUtils'

export default function CashierSalesReport({ dateRangeFilter, dataSource }) {
  const [cashiers, setCashiers] = useState([])
  const [catalogCategories, setCatalogCategories] = useState([])
  const [catalogProducts, setCatalogProducts] = useState([])
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState('')

  const [selectedCashier, setSelectedCashier] = useState('all')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [selectedProduct, setSelectedProduct] = useState('all')
  const [groupBy, setGroupBy] = useState('product')

  const [reportReceipts, setReportReceipts] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')
  const [generatedKey, setGeneratedKey] = useState('')
  const [exportStatus, setExportStatus] = useState('')

  // Lightweight catalog/staff lists only — never the full receipts history.
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- matches useApi's mount-time load pattern
    setOptionsLoading(true)
    Promise.all([api.cashiers(), api.categories(), api.products()])
      .then(([cashierList, categoryList, productList]) => {
        if (cancelled) return
        setCashiers(cashierList || [])
        setCatalogCategories(categoryList || [])
        setCatalogProducts(productList || [])
      })
      .catch((err) => { if (!cancelled) setOptionsError(err.message || 'Unable to load filter options.') })
      .finally(() => { if (!cancelled) setOptionsLoading(false) })
    return () => { cancelled = true }
  }, [])

  const cashierOptions = useMemo(() => {
    const names = new Set()
    for (const cashier of cashiers) {
      if (cashier.name) names.add(cashier.name)
      else if (cashier.email) names.add(cashier.email)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [cashiers])

  const categoryOptions = useMemo(() => {
    const names = new Set()
    for (const category of catalogCategories) {
      const name = String(category?.name || '').trim()
      if (name) names.add(name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [catalogCategories])

  const productOptions = useMemo(() => {
    const names = new Set()
    for (const product of catalogProducts) {
      if (product?.name) names.add(product.name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [catalogProducts])

  const currentKey = `${dataSource}|${dateRangeFilter.from}|${dateRangeFilter.to}|${selectedCashier}`
  const isStale = reportReceipts !== null && generatedKey !== currentKey

  async function generateReport() {
    setReportLoading(true)
    setReportError('')
    try {
      const data = await api.receipts({
        cashierName: selectedCashier === 'all' ? '' : selectedCashier,
        fromDate: dateRangeFilter.from,
        toDate: dateRangeFilter.to,
      })
      setReportReceipts(resolveReceiptCategories(data, catalogCategories, catalogProducts))
      setGeneratedKey(currentKey)
    } catch (err) {
      setReportError(err.message || 'Unable to load the report.')
    } finally {
      setReportLoading(false)
    }
  }

  const filteredReceipts = useMemo(
    () => filterReceiptsByProductCategory(reportReceipts || [], { productFilter: selectedProduct, categoryFilter: selectedCategory }),
    [reportReceipts, selectedProduct, selectedCategory],
  )
  const productSummary = useMemo(() => summarizeSalesByProduct(filteredReceipts), [filteredReceipts])
  const categorySummary = useMemo(() => summarizeByCategory(productSummary), [productSummary])
  const rows = groupBy === 'category' ? categorySummary : productSummary
  const totals = rows.reduce((acc, row) => ({ quantity: acc.quantity + row.quantity, revenue: acc.revenue + row.revenue }), { quantity: 0, revenue: 0 })

  async function exportReport() {
    const cashierLabel = selectedCashier === 'all' ? 'All Cashiers' : selectedCashier
    const rangeLabel = `${dateRangeFilter.from || 'All time'} to ${dateRangeFilter.to || 'Today'}`
    const header = groupBy === 'category' ? ['Category', 'Quantity Sold', 'Revenue'] : ['Product', 'Category', 'Quantity Sold', 'Revenue']
    const body = rows.map((row) => (
      groupBy === 'category' ? [row.category, row.quantity, row.revenue] : [row.product, row.category, row.quantity, row.revenue]
    ))
    try {
      const result = await exportCsv(
        `cashier-sales-${safeFilenamePart(cashierLabel)}-${new Date().toISOString().slice(0, 10)}.csv`,
        [['Cashier', cashierLabel], ['Date range', rangeLabel], header, ...body],
        { directory: getExportLocation(exportLocationKeys.reports) },
      )
      setExportStatus(`Exported to ${result.path}`)
    } catch (err) {
      setExportStatus(err.message || 'Unable to export report.')
    }
    window.setTimeout(() => setExportStatus(''), 3200)
  }

  return (
    <div className="card cashier-sales-report">
      <div className="panel-head">
        <div>
          <h3>Sales by Cashier</h3>
          <span className="sub">Pick a cashier, then a category or product, and generate a report.</span>
        </div>
      </div>

      {optionsError && <div className="empty"><h4>Unable to load filter options</h4><p>{optionsError}</p></div>}

      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" value={selectedCashier} onChange={(event) => setSelectedCashier(event.target.value)} disabled={optionsLoading} aria-label="Cashier">
          <option value="all">All Cashiers</option>
          {cashierOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select className="select" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)} disabled={optionsLoading} aria-label="Category">
          <option value="all">All Categories</option>
          {categoryOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select className="select" value={selectedProduct} onChange={(event) => setSelectedProduct(event.target.value)} disabled={optionsLoading} aria-label="Product">
          <option value="all">All Products</option>
          {productOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="btn btn-primary" onClick={generateReport} disabled={reportLoading || optionsLoading}>
          {reportLoading ? 'Generating…' : 'Show Report'}
        </button>
        {rows.length > 0 && (
          <button className="btn btn-outline" onClick={exportReport}>Export CSV</button>
        )}
      </div>

      {exportStatus && <div className="export-status">{exportStatus}</div>}
      {reportError && <div className="empty"><h4>Unable to load report</h4><p>{reportError}</p></div>}

      {isStale && (
        <div className="export-status">Filters changed — click "Show Report" to refresh.</div>
      )}

      {reportReceipts === null ? (
        <div className="empty">
          <h4>No report generated yet</h4>
          <p>Pick a cashier and date range above, then click "Show Report".</p>
        </div>
      ) : (
        <>
          <div className="scan-mode-row" role="tablist" aria-label="Group report by">
            <button type="button" className={`scan-mode ${groupBy === 'product' ? 'active' : ''}`} onClick={() => setGroupBy('product')}>By Product</button>
            <button type="button" className={`scan-mode ${groupBy === 'category' ? 'active' : ''}`} onClick={() => setGroupBy('category')}>By Category</button>
          </div>

          <div className="analytics-kpi-grid" style={{ marginTop: 12, marginBottom: 12 }}>
            <div className="analytics-kpi"><span>Total Quantity Sold</span><strong>{totals.quantity}</strong></div>
            <div className="analytics-kpi"><span>Total Revenue</span><strong>{peso(totals.revenue)}</strong></div>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {groupBy === 'product' && <th>Product</th>}
                  <th>Category</th>
                  <th>Quantity Sold</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={groupBy === 'product' ? 4 : 3}>No sales match the current filters.</td></tr>
                ) : rows.map((row) => (
                  <tr key={`${row.category}-${row.product || ''}`}>
                    {groupBy === 'product' && <td>{row.product}</td>}
                    <td>{row.category}</td>
                    <td>{row.quantity}</td>
                    <td>{peso(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
