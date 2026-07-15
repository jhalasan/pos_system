import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PageLoader from '../components/PageLoader'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import { IconArrowSwap, IconBarcode, IconDownload, IconPrint, IconReceipt, IconSearch } from '../components/Icons'
import { api, peso } from '../services/api'
import { useApi } from '../hooks/useApi'
import { exportCsv } from '../utils/exportCsv'
import { exportLocationKeys, getExportLocation } from '../utils/exportSettings'
import { printCompletedReceipt, printReceiptPdf } from '../../cashier-pos/services/receiptPrinter'
import GCashPayments from './GCashPayments'
import { sortTransactionRecords } from '../utils/transactionLogUtils'
import { localDateKey } from '../utils/localDate'

const PAGE_SIZE = 10
const PRESETS_KEY = 'nexa_transaction_log_presets'

function todayDate() {
  return localDateKey()
}

function monthStartDate() {
  const now = new Date()
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), 1))
}

function lastDaysDate(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return localDateKey(date)
}

function formatDate(value) {
  if (!value) return '-'
  return new Date(value).toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizedStatus(record) {
  return String(record.rawStatus || record.status || 'completed').toLowerCase()
}

function filterDates(range, customFrom, customTo) {
  if (range === 'today') return { fromDate: todayDate(), toDate: todayDate() }
  if (range === '7days') return { fromDate: lastDaysDate(6), toDate: todayDate() }
  if (range === 'month') return { fromDate: monthStartDate(), toDate: todayDate() }
  if (range === 'custom') return { fromDate: customFrom, toDate: customTo }
  return { fromDate: '', toDate: '' }
}

function receiptPayment(record) {
  return {
    paymentMethod: record.paymentMethod,
    totalAmount: record.totalAmount,
    subtotalAmount: record.subtotalAmount || record.totalAmount,
    discountPercent: record.discountPercent,
    discountAmount: record.discountAmount,
    cashAmount: record.cashAmount,
    gcashAmount: record.gcashAmount,
    splitPayments: record.splitPayments,
    gcashRef: record.refNumber,
  }
}

function receiptData(record) {
  return {
    transactionNo: record.transactionNo || record.receiptNo,
    cashierName: record.cashierName || 'Cashier',
    customerName: record.customerName || '',
    completedAt: record.createdAt,
    items: record.items || [],
    payment: receiptPayment(record),
  }
}

function safeFilenamePart(value) {
  return String(value || 'transaction')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function itemCountDisplay(receipt) {
  if (receipt.itemCount !== null && receipt.itemCount !== undefined) return receipt.itemCount
  const items = receipt.items || []
  const counted = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  if (receipt.missingItems) return 'Untracked'
  return counted > 0 ? counted : '-'
}

function paymentBreakdown(receipt) {
  const method = String(receipt.paymentMethod || '').toLowerCase()
  const splitCash = Number(receipt.splitPayments?.cash) || 0
  const splitGcash = Number(receipt.splitPayments?.gcash) || 0
  const total = Number(receipt.totalAmount) || 0
  const cash = method === 'split' ? splitCash : (method === 'cash' ? Number(receipt.cashAmount || total) || 0 : 0)
  const gcash = method === 'split' ? splitGcash : (method === 'gcash' ? Number(receipt.gcashAmount || total) || 0 : 0)
  return {
    cash,
    gcash,
    cashSubtotal: cash,
    gcashSubtotal: gcash,
    total,
  }
}

export default function TransactionLogs() {
  const { data: receipts, setData: setReceipts, loading, error } = useApi(api.receipts, [])
  const { data: cashiers } = useApi(api.cashiers, [])
  const { data: catalogProducts } = useApi(api.products, [])
  const { data: catalogCategories } = useApi(api.categories, [])
  const scanInputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [cashierName, setCashierName] = useState('all')
  const [action, setAction] = useState('all')
  const [status, setStatus] = useState('all')
  const [subTab, setSubTab] = useState('transactions')
  const [selectedReceipt, setSelectedReceipt] = useState(null)
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [sortOrder, setSortOrder] = useState('newest')
  const [refreshing, setRefreshing] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [customerNameFilter, setCustomerNameFilter] = useState('')
  const [productFilter, setProductFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]') }
    catch { return [] }
  })
  const [showPresetModal, setShowPresetModal] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetError, setPresetError] = useState('')

  const refreshReceipts = useCallback(async ({ showProgress = false } = {}) => {
    if (showProgress) setRefreshing(true)
    try {
      setReceipts(await api.receipts())
    } finally {
      if (showProgress) setRefreshing(false)
    }
  }, [setReceipts])

  useEffect(() => {
    const handleSyncStatus = (event) => {
      if (['succeeded', 'failed'].includes(event.detail?.state)) void refreshReceipts()
    }
    const handleFocus = () => void refreshReceipts()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshReceipts()
    }

    globalThis.addEventListener?.('nexa-sync-status', handleSyncStatus)
    globalThis.addEventListener?.('focus', handleFocus)
    document.addEventListener?.('visibilitychange', handleVisibility)
    return () => {
      globalThis.removeEventListener?.('nexa-sync-status', handleSyncStatus)
      globalThis.removeEventListener?.('focus', handleFocus)
      document.removeEventListener?.('visibilitychange', handleVisibility)
    }
  }, [refreshReceipts])

  const cashierOptions = useMemo(() => {
    const names = new Set()
    for (const cashier of cashiers || []) {
      if (cashier.name) names.add(cashier.name)
      else if (cashier.email) names.add(cashier.email)
    }
    for (const receipt of receipts || []) {
      if (receipt.cashierName) names.add(receipt.cashierName)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [cashiers, receipts])

  const resolvedReceipts = useMemo(() => {
    const categoryNames = new Map()
    for (const category of catalogCategories || []) {
      const name = String(category?.name || category?.id || '').trim()
      if (!name) continue
      categoryNames.set(String(category.id || name), name)
      categoryNames.set(name, name)
    }
    const productsById = new Map()
    const productsByBarcode = new Map()
    const productsByName = new Map()
    for (const product of catalogProducts || []) {
      if (product.id) productsById.set(String(product.id), product)
      if (product.barcode) productsByBarcode.set(String(product.barcode), product)
      if (product.name) productsByName.set(String(product.name).toLowerCase(), product)
    }
    const categoryForItem = (item) => {
      const raw = String(item.category || '').trim()
      if (categoryNames.has(raw)) return categoryNames.get(raw)
      const product = productsById.get(String(item.productId || ''))
        || productsByBarcode.get(String(item.barcode || item.matchingUnitBarcode || ''))
        || productsByName.get(String(item.name || '').toLowerCase())
      const productCategory = String(product?.category || product?.categoryId || '').trim()
      if (categoryNames.has(productCategory)) return categoryNames.get(productCategory)
      if (productCategory && !/^cat[a-z0-9]+$/i.test(productCategory)) return productCategory
      if (raw && !/^cat[a-z0-9]+$/i.test(raw)) return raw
      return 'Uncategorized (Legacy)'
    }
    return (receipts || []).map((receipt) => ({
      ...receipt,
      items: (receipt.items || []).map((item) => ({ ...item, category: categoryForItem(item) })),
    }))
  }, [catalogCategories, catalogProducts, receipts])

  const { productOptions, categoryOptions } = useMemo(() => {
    const products = new Set()
    const categories = new Set()
    for (const category of catalogCategories || []) {
      const name = String(category?.name || category?.id || '').trim()
      if (name && !/^cat[a-z0-9]+$/i.test(name)) categories.add(name)
    }
    for (const receipt of resolvedReceipts) for (const item of receipt.items || []) {
      if (item.name) products.add(item.name)
      if (item.category) categories.add(item.category)
    }
    return {
      productOptions: [...products].sort((a, b) => a.localeCompare(b)),
      categoryOptions: [...categories].sort((a, b) => a.localeCompare(b)),
    }
  }, [catalogCategories, resolvedReceipts])

  const filteredReceipts = useMemo(() => {
    const search = query.trim().toLowerCase()
    const { fromDate, toDate } = filterDates(dateRange, customFrom, customTo)
    const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
    const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null

    return resolvedReceipts.filter((receipt) => {
      const created = new Date(receipt.createdAt).getTime()
      const receiptStatus = normalizedStatus(receipt)
      const matchesQuery = !search || [
        receipt.receiptNo,
        receipt.transactionNo,
        receipt.cashierName,
        receipt.paymentMethod,
        receipt.customerName,
        ...(receipt.items || []).flatMap((item) => [item.name, item.barcode, item.category]),
      ].some((value) => String(value || '').toLowerCase().includes(search))
      const items = receipt.items || []
      const matchesCustomer = !customerNameFilter.trim() || String(receipt.customerName || '').toLowerCase().includes(customerNameFilter.trim().toLowerCase())
      const matchesProduct = productFilter === 'all' || items.some((item) => item.name === productFilter)
      const matchesCategory = categoryFilter === 'all' || items.some((item) => item.category === categoryFilter)
      const matchesPayment = paymentFilter === 'all' || String(receipt.paymentMethod || '').toLowerCase() === paymentFilter
      const amount = Number(receipt.totalAmount) || 0
      const matchesAmount = (minAmount === '' || amount >= Number(minAmount)) && (maxAmount === '' || amount <= Number(maxAmount))
      const matchesCashier = cashierName === 'all' || receipt.cashierName === cashierName
      const matchesStatus = status === 'all' || receiptStatus === status
      const matchesAction = action === 'all'
        || (action === 'reprintable' && receiptStatus !== 'voided')
        || (action === 'needs-review' && ['voided', 'adjusted'].includes(receiptStatus))
      const matchesDate = (!fromTime || created >= fromTime) && (!toTime || created <= toTime)
      return matchesQuery && matchesCustomer && matchesProduct && matchesCategory && matchesPayment && matchesAmount && matchesCashier && matchesStatus && matchesAction && matchesDate
    })
  }, [action, cashierName, categoryFilter, customerNameFilter, customFrom, customTo, dateRange, maxAmount, minAmount, paymentFilter, productFilter, query, resolvedReceipts, status])

  const totalAmount = filteredReceipts.reduce((sum, receipt) => sum + (Number(receipt.totalAmount) || 0), 0)
  const voidedCount = filteredReceipts.filter((receipt) => normalizedStatus(receipt) === 'voided').length
  const voidedAmount = filteredReceipts.filter((receipt) => normalizedStatus(receipt) === 'voided').reduce((sum, receipt) => sum + (Number(receipt.totalAmount) || 0), 0)
  const averageAmount = filteredReceipts.length ? totalAmount / filteredReceipts.length : 0
  const sortedReceipts = useMemo(
    () => sortTransactionRecords(filteredReceipts, sortOrder),
    [filteredReceipts, sortOrder],
  )
  const visibleReceipts = sortedReceipts.slice(0, visibleCount)
  const activeFilterCount = [query, customerNameFilter, customFrom, customTo, minAmount, maxAmount].filter((value) => String(value).trim()).length
    + [dateRange, cashierName, action, status, productFilter, categoryFilter, paymentFilter].filter((value) => value !== 'all').length
  const productSummary = useMemo(() => {
    const summary = new Map()
    for (const receipt of filteredReceipts) for (const item of receipt.items || []) {
      const key = `${item.category || 'Uncategorized'}|${item.name || 'Item'}`
      const current = summary.get(key) || { category: item.category || 'Uncategorized', product: item.name || 'Item', quantity: 0, revenue: 0 }
      current.quantity += Number(item.quantity) || 0
      current.revenue += (Number(item.quantity) || 0) * (Number(item.price) || 0)
      summary.set(key, current)
    }
    return [...summary.values()].sort((a, b) => b.revenue - a.revenue)
  }, [filteredReceipts])
  const filterChips = [
    query && { label: `Search: ${query}`, clear: () => setQuery('') },
    dateRange !== 'all' && { label: `Date: ${dateRange}`, clear: () => setDateRange('all') },
    categoryFilter !== 'all' && { label: `Category: ${categoryFilter}`, clear: () => setCategoryFilter('all') },
    productFilter !== 'all' && { label: `Product: ${productFilter}`, clear: () => setProductFilter('all') },
    customerNameFilter && { label: `Customer: ${customerNameFilter}`, clear: () => setCustomerNameFilter('') },
    cashierName !== 'all' && { label: `Cashier: ${cashierName}`, clear: () => setCashierName('all') },
    paymentFilter !== 'all' && { label: `Payment: ${paymentFilter}`, clear: () => setPaymentFilter('all') },
    status !== 'all' && { label: `Status: ${status}`, clear: () => setStatus('all') },
    action !== 'all' && { label: `Action: ${action}`, clear: () => setAction('all') },
    minAmount !== '' && { label: `Min: ${peso(minAmount)}`, clear: () => setMinAmount('') },
    maxAmount !== '' && { label: `Max: ${peso(maxAmount)}`, clear: () => setMaxAmount('') },
  ].filter(Boolean)

  useEffect(() => {
    // Reset pagination whenever the active result set or ordering changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleCount(PAGE_SIZE)
  }, [action, cashierName, categoryFilter, customerNameFilter, customFrom, customTo, dateRange, maxAmount, minAmount, paymentFilter, productFilter, query, sortOrder, status, subTab])

  async function handleReprint(receipt) {
    try {
      const result = await printCompletedReceipt(receiptData(receipt))
      setToast(result?.pdfPath
        ? `Receipt PDF saved to ${result.pdfPath}.`
        : `Reprinted transaction ${receipt.receiptNo || receipt.transactionNo}.`)
      window.setTimeout(() => setToast(''), 2400)
    } catch (err) {
      setToast((typeof err === 'string' ? err : err.message) || 'Unable to reprint receipt.')
      window.setTimeout(() => setToast(''), 3200)
    }
  }

  function clearFilters() {
    setQuery(''); setDateRange('all'); setCustomFrom(''); setCustomTo(''); setCashierName('all')
    setAction('all'); setStatus('all'); setCustomerNameFilter(''); setProductFilter('all')
    setCategoryFilter('all'); setPaymentFilter('all'); setMinAmount(''); setMaxAmount('')
  }

  function savePreset() {
    setPresetName('')
    setPresetError('')
    setShowPresetModal(true)
  }

  function confirmSavePreset() {
    const name = presetName.trim()
    if (!name) {
      setPresetError('Enter a name for this filter preset.')
      return
    }
    const preset = { name, query, dateRange, customFrom, customTo, cashierName, action, status, customerNameFilter, productFilter, categoryFilter, paymentFilter, minAmount, maxAmount }
    const next = [...presets.filter((item) => item.name !== name), preset]
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
    setShowPresetModal(false)
    setToast(`Saved filter preset “${name}”.`)
    window.setTimeout(() => setToast(''), 2400)
  }

  function applyPreset(preset) {
    setQuery(preset.query || ''); setDateRange(preset.dateRange || 'all'); setCustomFrom(preset.customFrom || ''); setCustomTo(preset.customTo || '')
    setCashierName(preset.cashierName || 'all'); setAction(preset.action || 'all'); setStatus(preset.status || 'all')
    setCustomerNameFilter(preset.customerNameFilter || ''); setProductFilter(preset.productFilter || 'all'); setCategoryFilter(preset.categoryFilter || 'all')
    setPaymentFilter(preset.paymentFilter || 'all'); setMinAmount(preset.minAmount || ''); setMaxAmount(preset.maxAmount || '')
  }

  async function handleDownloadPdf(receipt) {
    try {
      const filename = `${safeFilenamePart(receipt.receiptNo || receipt.transactionNo)}-receipt.pdf`
      const result = await printReceiptPdf(receiptData(receipt), { filename })
      setToast(`Soft copy saved to ${result.path}.`)
      window.setTimeout(() => setToast(''), 2400)
    } catch (err) {
      setToast((typeof err === 'string' ? err : err.message) || 'Unable to download receipt PDF.')
      window.setTimeout(() => setToast(''), 3200)
    }
  }

  async function handleExportTransactions() {
    const result = await exportCsv(`transaction-logs-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Transaction No.', 'Date / Time', 'Customer', 'Cashier', 'Status', 'Products', 'Categories', 'Items', 'Cash', 'GCash', 'Cash Subtotal', 'GCash Subtotal', 'Total'],
      ...sortedReceipts.map((receipt) => {
        const payment = paymentBreakdown(receipt)
        return [
          receipt.receiptNo || receipt.transactionNo,
          formatDate(receipt.createdAt),
          receipt.customerName || 'Walk-in Customer',
          receipt.cashierName || '',
          receipt.status || 'Completed',
          (receipt.items || []).map((item) => item.name).join('; '),
          [...new Set((receipt.items || []).map((item) => item.category).filter(Boolean))].join('; '),
          itemCountDisplay(receipt),
          payment.cash,
          payment.gcash,
          payment.cashSubtotal,
          payment.gcashSubtotal,
          payment.total,
        ]
      }),
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`Transaction sheet exported to ${result.path}.`)
    window.setTimeout(() => setToast(''), 2400)
  }

  async function handleExportTransaction(receipt) {
    const result = await exportCsv(`${safeFilenamePart(receipt.receiptNo || receipt.transactionNo)}-items.csv`, [
      ['Receipt No.', receipt.receiptNo || receipt.transactionNo],
      ['Date / Time', formatDate(receipt.createdAt)],
      ['Cashier', receipt.cashierName || ''],
      ['Customer', receipt.customerName || 'Walk-in Customer'],
      ['Status', receipt.status || 'Completed'],
      ['Payment', receipt.paymentMethod || ''],
      [],
      ['Item', 'Category', 'Barcode', 'Qty', 'Unit Price', 'Amount'],
      ...(receipt.items || []).map((item) => [
        item.name || 'Item',
        item.category || '',
        item.barcode || '',
        Number(item.quantity) || 0,
        Number(item.price) || 0,
        (Number(item.quantity) || 0) * (Number(item.price) || 0),
      ]),
      [],
      ['Subtotal', '', '', '', Number(receipt.subtotalAmount || receipt.totalAmount) || 0],
      ['Discount', '', '', '', Number(receipt.discountAmount) || 0],
      ['Total', '', '', '', Number(receipt.totalAmount) || 0],
    ], { directory: getExportLocation(exportLocationKeys.reports) })
    setToast(`Transaction sheet exported to ${result.path}.`)
    window.setTimeout(() => setToast(''), 2400)
  }

  if (loading) {
    return <PageLoader title="Transaction Logs" message="Loading transaction history…" />
  }

  if (error) {
    return (
      <>
        <PageHeader title="Transaction Logs" subtitle="Search transactions by receipt number, cashier, date, action, or status." />
        <div className="card"><div className="empty"><h4>Unable to load transactions</h4><p>{error}</p></div></div>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Transaction Logs" subtitle="All transaction history with receipt-number scan/search, date, cashier, action, and status filters.">
        <button className="btn btn-outline" onClick={() => refreshReceipts({ showProgress: true })} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
        <button className="btn btn-outline" onClick={handleExportTransactions} disabled={filteredReceipts.length === 0}>
          <IconDownload size={16} /> Export Sheet
        </button>
        <button className="btn btn-outline" onClick={() => scanInputRef.current?.focus()}>
          <IconBarcode size={16} /> Focus Scanner
        </button>
      </PageHeader>

      <div className="scan-mode-row analytics-tabs">
        <button
          type="button"
          className={`scan-mode ${subTab === 'transactions' ? 'active' : ''}`}
          onClick={() => setSubTab('transactions')}
        >
          Transactions
        </button>
        <button
          type="button"
          className={`scan-mode ${subTab === 'gcash' ? 'active' : ''}`}
          onClick={() => setSubTab('gcash')}
        >
          GCash Payments
        </button>
        <button type="button" className={`scan-mode ${subTab === 'products' ? 'active' : ''}`} onClick={() => setSubTab('products')}>Product Summary</button>
        <button type="button" className={`scan-mode ${subTab === 'categories' ? 'active' : ''}`} onClick={() => setSubTab('categories')}>Category Summary</button>
      </div>

      {subTab === 'gcash' ? (
        <GCashPayments embedded sourceReceipts={receipts} />
      ) : ['products', 'categories'].includes(subTab) ? (
        <div className="card">
          <div className="panel-head"><div><h3>{subTab === 'products' ? 'Product' : 'Category'} Sales Summary</h3><span className="sub">Quantity and revenue from the current transaction filters.</span></div></div>
          <div className="table-wrap"><table className="data"><thead><tr>{subTab === 'products' && <th>Product</th>}<th>Category</th><th>Quantity Sold</th><th>Revenue</th></tr></thead><tbody>
            {(subTab === 'products' ? productSummary : Object.values(productSummary.reduce((groups, row) => { const key = row.category; groups[key] ||= { category: key, quantity: 0, revenue: 0 }; groups[key].quantity += row.quantity; groups[key].revenue += row.revenue; return groups }, {}))).map((row) => <tr key={`${row.category}-${row.product || ''}`}>{subTab === 'products' && <td>{row.product}</td>}<td>{row.category}</td><td>{row.quantity}</td><td>{peso(row.revenue)}</td></tr>)}
          </tbody></table></div>
        </div>
      ) : (
      <>

      <div className="stat-grid transaction-stat-grid">
        <StatCard label="Matched Transactions" value={filteredReceipts.length} icon={IconReceipt} tone="indigo" foot={`${receipts.length} total record(s)`} />
        <StatCard label="Matched Sales" value={peso(totalAmount)} icon={IconPrint} tone="green" foot="Filtered total" />
        <StatCard label="Average Sale" value={peso(averageAmount)} icon={IconReceipt} tone="indigo" foot="Per matched transaction" />
        <StatCard label="Voided" value={voidedCount} icon={IconBarcode} tone="red" foot={`${peso(voidedAmount)} voided value`} />
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="transaction-filter-header">
          <div>
            <h3>Filters</h3>
            <span>Search and narrow transaction results.</span>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((value) => !value)}
          >
            Advanced Filters {showAdvanced ? '▴' : '▾'}
          </button>
        </div>
        <div className="panel-body">
          <div className="receipt-filter-grid compact-filter-grid">
            <div className="field span-2">
              <span>Receipt No. / Barcode Scan</span>
              <div className="input-search">
                <IconSearch size={16} />
                <input
                  ref={scanInputRef}
                  className="input"
                  placeholder="Scan barcode or enter receipt number"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.select()
                  }}
                />
              </div>
            </div>
            <label className="field">
              <span>Date Range</span>
              <select className="select" value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="7days">Last 7 days</option>
                <option value="month">This month</option>
                <option value="custom">Custom range</option>
              </select>
            </label>
            {showAdvanced && <label className="field">
              <span>Cashier Name</span>
              <select className="select" value={cashierName} onChange={(event) => setCashierName(event.target.value)}>
                <option value="all">All cashiers</option>
                {cashierOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>}
            <label className="field">
              <span>Customer Name</span>
              <input className="input" placeholder="Partial name" value={customerNameFilter} onChange={(event) => setCustomerNameFilter(event.target.value)} />
            </label>
            <label className="field">
              <span>Product</span>
              <select className="select" value={productFilter} onChange={(event) => setProductFilter(event.target.value)}>
                <option value="all">All products</option>
                {productOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Category</span>
              <select className="select" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value="all">All categories</option>
                {categoryOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {showAdvanced && <>
            <label className="field">
              <span>Payment Method</span>
              <select className="select" value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}>
                <option value="all">All payments</option><option value="cash">Cash</option><option value="gcash">GCash</option><option value="split">Split</option>
              </select>
            </label>
            <label className="field"><span>Minimum Amount</span><input className="input" type="number" min="0" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></label>
            <label className="field"><span>Maximum Amount</span><input className="input" type="number" min="0" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></label>
            <label className="field">
              <span>Actions</span>
              <select className="select" value={action} onChange={(event) => setAction(event.target.value)}>
                <option value="all">All actions</option>
                <option value="reprintable">Reprint available</option>
                <option value="needs-review">Needs review</option>
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="completed">Completed</option>
                <option value="voided">Voided</option>
                <option value="adjusted">Adjusted</option>
              </select>
            </label>
            </>}
            {dateRange === 'custom' && (
              <>
                <label className="field">
                  <span>From</span>
                  <input className="input" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
                </label>
                <label className="field">
                  <span>To</span>
                  <input className="input" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
                </label>
              </>
            )}
            <div className="field span-2 filter-preset-toolbar">
              <span>Saved Filters</span>
              <div className="row-actions">
                <select className="select" defaultValue="" onChange={(event) => { const preset = presets.find((item) => item.name === event.target.value); if (preset) applyPreset(preset) }}>
                  <option value="">Choose a preset</option>{presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
                </select>
                <button type="button" className="btn btn-outline btn-sm" onClick={savePreset}>Save Current</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>Clear Filters</button>
                <span className="muted">{activeFilterCount} active filter(s)</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {filterChips.length > 0 && <div className="transaction-filter-chips">{filterChips.map((chip) => <button type="button" key={chip.label} onClick={chip.clear}>{chip.label} <span>×</span></button>)}</div>}

      <div className="card">
        <div className="panel-head">
          <div>
            <h3>Transaction History</h3>
            <span className="sub">Includes completed, voided, and adjusted transactions when they are available in sales history.</span>
          </div>
          <div className="row-actions">
            <span className="muted">{filteredReceipts.length} result(s)</span>
            <IconArrowSwap size={15} />
            <select className="select" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label="Sort transactions">
              <option value="newest">Newest to Oldest</option><option value="oldest">Oldest to Newest</option>
              <option value="total-high">Highest Total</option><option value="total-low">Lowest Total</option>
              <option value="customer">Customer Name</option><option value="cashier">Cashier Name</option>
            </select>
          </div>
        </div>

        {filteredReceipts.length === 0 ? (
          <div className="empty">
            <div className="em-icon"><IconReceipt size={24} /></div>
            <h4>No transactions found</h4>
            <p>Scan a receipt barcode or adjust the filters.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data transaction-log-table">
              <thead>
                <tr>
                  <th>Transaction No.</th>
                  <th>Date / Time</th>
                  <th>Customer</th>
                  <th>Cashier</th>
                  <th>Items</th>
                  <th>Payment</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleReceipts.map((receipt) => {
                  const receiptStatus = normalizedStatus(receipt)
                  const payment = paymentBreakdown(receipt)
                  return (
                    <tr
                      key={receipt.id}
                      className="clickable-row"
                      onClick={() => setSelectedReceipt(receipt)}
                      title="Open transaction details"
                    >
                      <td>
                        <div className="prod-name">{receipt.receiptNo || receipt.transactionNo}</div>
                        <div className="prod-id">{receipt.paymentMethod || 'cash'}</div>
                      </td>
                      <td>{formatDate(receipt.createdAt)}</td>
                      <td title={receipt.customerName || 'Walk-in Customer'}>{receipt.customerName || 'Walk-in'}</td>
                      <td>{receipt.cashierName || '-'}</td>
                      <td>{itemCountDisplay(receipt)}</td>
                      <td><span className="badge badge-neutral">{String(receipt.paymentMethod || 'cash').toUpperCase()}</span></td>
                      <td><strong>{peso(payment.total)}</strong></td>
                      <td>
                        <span className={`badge ${receiptStatus === 'voided' ? 'badge-danger' : receiptStatus === 'adjusted' ? 'badge-warning' : 'badge-success'}`}>
                          {receipt.status || 'Completed'}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn transaction-action-button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedReceipt(receipt)
                          }}
                        >
                          •••
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filteredReceipts.length > visibleReceipts.length && (
              <div className="table-more-row">
                <button className="btn btn-outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                  Show More ({filteredReceipts.length - visibleReceipts.length} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showPresetModal && (
        <Modal
          title="Save Filter Preset"
          onClose={() => setShowPresetModal(false)}
          footer={(
            <>
              <button type="button" className="btn btn-outline" onClick={() => setShowPresetModal(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={confirmSavePreset}>Save Preset</button>
            </>
          )}
        >
          <label className="field">
            <span>Preset Name</span>
            <input
              autoFocus
              className="input"
              value={presetName}
              maxLength={60}
              placeholder="Example: Today’s Pepsi sales"
              onChange={(event) => { setPresetName(event.target.value); setPresetError('') }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); confirmSavePreset() }
              }}
            />
            {presetError && <small className="field-error">{presetError}</small>}
          </label>
          <p className="muted" style={{ marginTop: 12 }}>This saves the filters currently applied to Transaction Logs on this computer.</p>
        </Modal>
      )}

      {selectedReceipt && (
        <Modal
          title={`Transaction ${selectedReceipt.receiptNo || selectedReceipt.transactionNo}`}
          onClose={() => setSelectedReceipt(null)}
          footer={(
            <>
              <button className="btn btn-outline" onClick={() => handleExportTransaction(selectedReceipt)}>
                <IconDownload size={16} /> Export Sheet
              </button>
              <button className="btn btn-outline" onClick={() => handleDownloadPdf(selectedReceipt)}>
                <IconDownload size={16} /> Download PDF
              </button>
              <button className="btn btn-primary" onClick={() => handleReprint(selectedReceipt)}>
                <IconPrint size={16} /> Print
              </button>
            </>
          )}
        >
          <div className="transaction-detail">
            <div className="transaction-soft-copy">
              <div className="receipt-brand">ARJOV CONSUMER GOODS TRADING</div>
              <div>Aparente Street Ext.</div>
              <div>Purok Malakas Brgy. San Isidro</div>
              <div>General Santos City</div>
              <div className="receipt-title">Sale Receipt</div>
              <div className="receipt-rule" />
              <div className="receipt-meta">
                <span>Receipt No.</span><strong>{selectedReceipt.receiptNo || selectedReceipt.transactionNo}</strong>
                <span>Date</span><strong>{formatDate(selectedReceipt.createdAt)}</strong>
                <span>Cashier</span><strong>{selectedReceipt.cashierName || 'Cashier'}</strong>
                <span>Customer</span><strong>{selectedReceipt.customerName || 'Walk-in Customer'}</strong>
                <span>Status</span><strong>{selectedReceipt.status || 'Completed'}</strong>
              </div>
              <div className="receipt-rule" />
              <div className="receipt-items">
                {(selectedReceipt.items || []).length === 0 && (
                  <div className="muted">Item details are not available for this transaction.</div>
                )}
                {(selectedReceipt.items || []).map((item) => (
                  <div className="receipt-item" key={`${item.productId || item.id}-${item.name}`}>
                    <div>
                      <strong>{item.name || 'Item'}</strong>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>
                        {Number(item.quantity) || 0} {item.unit || 'unit'} x {peso(item.price)}
                        {item.matchingUnitBarcode ? (
                          <span style={{ marginLeft: 8 }}>| Scanned Barcode: {item.matchingUnitBarcode}</span>
                        ) : null}
                      </div>
                    </div>
                    <strong>{peso((Number(item.quantity) || 0) * (Number(item.price) || 0))}</strong>
                  </div>
                ))}
              </div>
              <div className="receipt-rule" />
              <div className="receipt-totals">
                <span>Items</span><strong>{itemCountDisplay(selectedReceipt)}</strong>
                <span>Subtotal</span><strong>{peso(selectedReceipt.subtotalAmount || selectedReceipt.totalAmount)}</strong>
                <span>Cash Subtotal</span><strong>{peso(paymentBreakdown(selectedReceipt).cashSubtotal)}</strong>
                <span>GCash Subtotal</span><strong>{peso(paymentBreakdown(selectedReceipt).gcashSubtotal)}</strong>
                {Number(selectedReceipt.discountAmount) > 0 && (
                  <>
                    <span>Discount</span><strong>-{peso(selectedReceipt.discountAmount)}</strong>
                  </>
                )}
                <span>Total</span><strong>{peso(selectedReceipt.totalAmount)}</strong>
                <span>Cash</span><strong>{peso(paymentBreakdown(selectedReceipt).cash)}</strong>
                <span>GCash</span><strong>{peso(paymentBreakdown(selectedReceipt).gcash)}</strong>
                <span>Payment</span><strong>{selectedReceipt.paymentMethod || 'Cash'}</strong>
              </div>
              <div className="receipt-rule" />
              <div className="receipt-disclaimer">NOT AN OFFICIAL RECEIPT</div>
            </div>
          </div>
        </Modal>
      )}

      {toast && <div className="toast"><IconPrint size={15} /> {toast}</div>}
      </>
      )}
    </>
  )
}
