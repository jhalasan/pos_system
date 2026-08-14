# Cashier Sales Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "By Cashier" report tab to the Analytics page where the owner picks a cashier (e.g. Arlie Velasco), optionally narrows by product/category, and generates a report table of what that cashier sold — quantity and revenue — similar to Aronium POS's "Sales by Product" report (filter panel → "Show Report" → results table → export).

**Architecture:** Pure frontend feature reusing the existing `/api/receipts` endpoint and the existing category/product-summary aggregation logic already proven in `TransactionLogs.jsx`. To avoid adding load on top of the app's known PocketBase rate-limit sensitivity, the report is **lazy and explicit**: no data loads when the Analytics page or the new tab is opened; the owner must click "Show Report" to fetch, and the fetch is scoped to the selected date range + cashier via a small server-side filter added to `/api/receipts`. Cashier/Category/Product dropdown options come from lightweight catalog/staff lists, never from a full receipts fetch.

**Tech Stack:** React (JSX, no TypeScript), existing `useApi` hook, PocketBase via Express `server/index.js`, `node:test` for unit tests (existing project convention — no React component testing library in this repo).

**Spec:** No separate spec file — this is a bounded enhancement to existing pages (`Analytics.jsx`, `TransactionLogs.jsx`), scoped through in-chat design discussion. This document's Goal/Architecture sections carry the full context.

## Global Constraints

- Do not introduce a new full-history receipts fetch anywhere in this feature. Any new call to `api.receipts(...)` must pass `fromDate`/`toDate` (and ideally `cashierName`) and must be triggered by explicit user action, not by a page-mount effect.
- Follow the codebase's existing test convention: pure logic goes in `src/admin-page/utils/*.js` files and is covered by `node:test` files under `tests/`; JSX components are not unit-tested (no test files exist for `.jsx` files in this repo).
- New/changed test files must be added to the `test:offline` script in `package.json` so they run in CI, matching how `tests/transaction-log-sort.test.js` is already registered there.
- Match existing UI conventions: `.card` filter panels, `.select`/`.input` form controls, `.scan-mode`/`.scan-mode-row` for tab toggles, `exportCsv` for CSV export, `peso()` for currency formatting — all already used in `TransactionLogs.jsx` and `Analytics.jsx`.

---

### Task 1: Add server-side date-range filtering to `/api/receipts`

**Files:**
- Modify: `server/index.js:1018-1055` (the `GET /api/receipts` handler)

**Interfaces:**
- Consumes: `pb.filter(query, params)` and `pbCollection('sales')` — both already imported at the top of `server/index.js` from `./pocketbase.js` and already used with this exact pattern elsewhere (e.g. `server/index.js:947-949`).
- Produces: no change to the response shape or the `fromDate`/`toDate` query params the client already sends — this task only narrows the initial PocketBase query when those params are present. Behavior with no date params (e.g. "All Time") is unchanged.

This is a performance-only change: today `GET /api/receipts` always does `getFullList` over the *entire* `sales` collection (plus a `sale_items` lookup per sale) regardless of the `fromDate`/`toDate` query params — those are only applied to the in-memory result *after* the full fetch. Adding the filter to the PocketBase query itself means a request scoped to, say, the last 7 days actually only pulls 7 days of sales from PocketBase, directly reducing the request volume that has caused rate-limit issues before (see `cee7d4e`, `812f574`). The existing in-memory date filter stays as-is — it remains the source of truth for exact boundaries; the new server-side filter is just a coarse pre-narrowing.

- [ ] **Step 1: Read current handler to confirm line numbers before editing**

Open `server/index.js` around line 1018 and confirm the handler still matches:

```js
app.get('/api/receipts', asyncRoute(async (req, res) => {
  const q = String(req.query?.q || '').trim().toLowerCase()
  const cashierName = String(req.query?.cashierName || '').trim().toLowerCase()
  const status = String(req.query?.status || 'all').trim().toLowerCase()
  const action = String(req.query?.action || 'all').trim().toLowerCase()
  const fromDate = String(req.query?.fromDate || '').trim()
  const toDate = String(req.query?.toDate || '').trim()

  const sales = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    perPage: 500,
  })
```

If the surrounding code has drifted, adapt the edit below to the current structure rather than blindly pasting.

- [ ] **Step 2: Add the date filter to the PocketBase query**

Replace the `sales` fetch with:

```js
  const dateFilterParts = []
  if (fromDate) dateFilterParts.push(pb.filter('created_at >= {:from}', { from: `${fromDate} 00:00:00` }))
  if (toDate) dateFilterParts.push(pb.filter('created_at <= {:to}', { to: `${toDate} 23:59:59` }))

  const sales = await (await pbCollection('sales')).getFullList({
    sort: '-created_at,-created',
    expand: 'cashier_id',
    perPage: 500,
    ...(dateFilterParts.length ? { filter: dateFilterParts.join(' && ') } : {}),
  })
```

- [ ] **Step 3: Manually verify against a running dev PocketBase**

There is no automated test coverage for this route today (no PocketBase instance available in the `node:test` suite — `tests/admin-vercel-boundary.test.js` boots the Express app but never hits a real PocketBase-backed route). Verify manually instead:

1. Run `npm run dev` (or however you normally run the app locally) with PocketBase reachable.
2. Log in as admin, open Transaction Logs, and confirm receipts still load and the existing date-range filter (`today`/`7days`/`month`/custom) still returns the same rows as before this change.
3. Hit `GET /api/receipts?fromDate=2026-08-01&toDate=2026-08-14` directly (e.g. via browser devtools or curl with an admin token) and confirm it returns only receipts in that window.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "perf: scope /api/receipts PocketBase query to the requested date range"
```

---

### Task 2: Extract shared receipt category/summary utilities

**Files:**
- Create: `src/admin-page/utils/receiptSalesUtils.js`
- Test: `tests/receipt-sales-utils.test.js`
- Modify: `src/admin-page/pages/TransactionLogs.jsx` (replace inline logic with imports — see Task 3)

**Interfaces:**
- Produces (used by Task 3 and Task 5):
  - `resolveReceiptCategories(receipts, catalogCategories, catalogProducts) => receipts[]` — same shape as input, with each item's `category` resolved to a display name via the catalog (falls back to `'Uncategorized (Legacy)'`).
  - `summarizeSalesByProduct(receipts) => [{ category, product, quantity, revenue }]` sorted by `revenue` descending.
  - `summarizeByCategory(productSummary) => [{ category, quantity, revenue }]` sorted by `revenue` descending — takes the output of `summarizeSalesByProduct`.
  - `filterReceiptsByProductCategory(receipts, { productFilter = 'all', categoryFilter = 'all' }) => receipts[]`.

This extracts logic that today lives inline in `TransactionLogs.jsx` (`resolvedReceipts` at lines 187-219, `productSummary` at lines 283-293, the category-grouping `reduce` at line 478, and the `matchesProduct`/`matchesCategory` checks at lines 257-258) into pure, tested functions so the new cashier report (Task 5) can reuse the exact same behavior instead of re-implementing it.

- [ ] **Step 1: Write the failing tests**

Create `tests/receipt-sales-utils.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveReceiptCategories,
  summarizeSalesByProduct,
  summarizeByCategory,
  filterReceiptsByProductCategory,
} from '../src/admin-page/utils/receiptSalesUtils.js'

const catalogCategories = [{ id: 'cat1', name: 'Beverages' }, { id: 'cat2', name: 'Snacks' }]
const catalogProducts = [
  { id: 'p1', name: 'Coke 1L', barcode: '1001', category: 'cat1' },
  { id: 'p2', name: 'Chips', barcode: '1002', category: 'cat2' },
]

test('resolveReceiptCategories resolves a category id to its display name', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Coke 1L', category: 'cat1', quantity: 2, price: 50 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Beverages')
})

test('resolveReceiptCategories falls back to the product catalog when item category is missing', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Chips', barcode: '1002', category: '', quantity: 1, price: 20 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Snacks')
})

test('resolveReceiptCategories falls back to Uncategorized (Legacy) when nothing matches', () => {
  const receipts = [{ id: 'r1', items: [{ name: 'Mystery Item', category: '', quantity: 1, price: 10 }] }]
  const [resolved] = resolveReceiptCategories(receipts, catalogCategories, catalogProducts)
  assert.equal(resolved.items[0].category, 'Uncategorized (Legacy)')
})

test('summarizeSalesByProduct aggregates quantity and revenue per product, sorted by revenue desc', () => {
  const receipts = [
    { items: [{ name: 'Coke 1L', category: 'Beverages', quantity: 2, price: 50 }] },
    { items: [{ name: 'Coke 1L', category: 'Beverages', quantity: 1, price: 50 }] },
    { items: [{ name: 'Chips', category: 'Snacks', quantity: 5, price: 20 }] },
  ]
  const summary = summarizeSalesByProduct(receipts)
  assert.deepEqual(summary, [
    { category: 'Snacks', product: 'Chips', quantity: 5, revenue: 100 },
    { category: 'Beverages', product: 'Coke 1L', quantity: 3, revenue: 150 },
  ].sort((a, b) => b.revenue - a.revenue))
})

test('summarizeByCategory rolls a product summary up to category totals', () => {
  const productSummary = [
    { category: 'Beverages', product: 'Coke 1L', quantity: 3, revenue: 150 },
    { category: 'Beverages', product: 'Sprite 1L', quantity: 1, revenue: 45 },
    { category: 'Snacks', product: 'Chips', quantity: 5, revenue: 100 },
  ]
  const summary = summarizeByCategory(productSummary)
  assert.deepEqual(summary, [
    { category: 'Beverages', quantity: 4, revenue: 195 },
    { category: 'Snacks', quantity: 5, revenue: 100 },
  ])
})

test('filterReceiptsByProductCategory keeps only receipts containing the selected product', () => {
  const receipts = [
    { id: 'r1', items: [{ name: 'Coke 1L', category: 'Beverages' }] },
    { id: 'r2', items: [{ name: 'Chips', category: 'Snacks' }] },
  ]
  const result = filterReceiptsByProductCategory(receipts, { productFilter: 'Coke 1L' })
  assert.deepEqual(result.map((r) => r.id), ['r1'])
})

test('filterReceiptsByProductCategory keeps only receipts containing the selected category', () => {
  const receipts = [
    { id: 'r1', items: [{ name: 'Coke 1L', category: 'Beverages' }] },
    { id: 'r2', items: [{ name: 'Chips', category: 'Snacks' }] },
  ]
  const result = filterReceiptsByProductCategory(receipts, { categoryFilter: 'Snacks' })
  assert.deepEqual(result.map((r) => r.id), ['r2'])
})

test('filterReceiptsByProductCategory returns everything when filters are "all"', () => {
  const receipts = [{ id: 'r1', items: [] }, { id: 'r2', items: [] }]
  const result = filterReceiptsByProductCategory(receipts, { productFilter: 'all', categoryFilter: 'all' })
  assert.equal(result.length, 2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/receipt-sales-utils.test.js`
Expected: FAIL — `Cannot find module '../src/admin-page/utils/receiptSalesUtils.js'`

- [ ] **Step 3: Implement `src/admin-page/utils/receiptSalesUtils.js`**

```js
function buildCategoryResolver(catalogCategories = [], catalogProducts = []) {
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

  return function categoryForItem(item) {
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
}

export function resolveReceiptCategories(receipts = [], catalogCategories = [], catalogProducts = []) {
  const categoryForItem = buildCategoryResolver(catalogCategories, catalogProducts)
  return (receipts || []).map((receipt) => ({
    ...receipt,
    items: (receipt.items || []).map((item) => ({ ...item, category: categoryForItem(item) })),
  }))
}

export function summarizeSalesByProduct(receipts = []) {
  const summary = new Map()
  for (const receipt of receipts || []) for (const item of receipt.items || []) {
    const key = `${item.category || 'Uncategorized'}|${item.name || 'Item'}`
    const current = summary.get(key) || { category: item.category || 'Uncategorized', product: item.name || 'Item', quantity: 0, revenue: 0 }
    current.quantity += Number(item.quantity) || 0
    current.revenue += (Number(item.quantity) || 0) * (Number(item.price) || 0)
    summary.set(key, current)
  }
  return [...summary.values()].sort((a, b) => b.revenue - a.revenue)
}

export function summarizeByCategory(productSummary = []) {
  const groups = productSummary.reduce((acc, row) => {
    const key = row.category
    acc[key] ||= { category: key, quantity: 0, revenue: 0 }
    acc[key].quantity += row.quantity
    acc[key].revenue += row.revenue
    return acc
  }, {})
  return Object.values(groups).sort((a, b) => b.revenue - a.revenue)
}

export function filterReceiptsByProductCategory(receipts = [], { productFilter = 'all', categoryFilter = 'all' } = {}) {
  return (receipts || []).filter((receipt) => {
    const items = receipt.items || []
    const matchesProduct = productFilter === 'all' || items.some((item) => item.name === productFilter)
    const matchesCategory = categoryFilter === 'all' || items.some((item) => item.category === categoryFilter)
    return matchesProduct && matchesCategory
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/receipt-sales-utils.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/admin-page/utils/receiptSalesUtils.js tests/receipt-sales-utils.test.js
git commit -m "feat: extract shared receipt category/summary utilities"
```

---

### Task 3: Refactor `TransactionLogs.jsx` to use the shared utilities

**Files:**
- Modify: `src/admin-page/pages/TransactionLogs.jsx:187-219` (the `resolvedReceipts` memo), `:283-293` (the `productSummary` memo), `:257-258` (`matchesProduct`/`matchesCategory`), `:478` (the category-grouping `reduce` in JSX)

**Interfaces:**
- Consumes: `resolveReceiptCategories`, `summarizeSalesByProduct`, `summarizeByCategory` from `../utils/receiptSalesUtils.js` (Task 2).

This is a behavior-preserving refactor: same output, less duplicated logic, so Task 5's new report can rely on the exact same aggregation rules without drifting from what Transaction Logs already shows.

- [ ] **Step 1: Add the import**

At the top of `src/admin-page/pages/TransactionLogs.jsx`, add:

```js
import { resolveReceiptCategories, summarizeSalesByProduct, summarizeByCategory } from '../utils/receiptSalesUtils'
```

- [ ] **Step 2: Replace `resolvedReceipts`**

Replace the `resolvedReceipts` `useMemo` block (`TransactionLogs.jsx:187-219`) with:

```js
  const resolvedReceipts = useMemo(
    () => resolveReceiptCategories(receipts, catalogCategories, catalogProducts),
    [catalogCategories, catalogProducts, receipts],
  )
```

- [ ] **Step 3: Replace `productSummary`**

Replace the `productSummary` `useMemo` block (`TransactionLogs.jsx:283-293`) with:

```js
  const productSummary = useMemo(() => summarizeSalesByProduct(filteredReceipts), [filteredReceipts])
  const categorySummary = useMemo(() => summarizeByCategory(productSummary), [productSummary])
```

- [ ] **Step 4: Use `categorySummary` in the table render**

At `TransactionLogs.jsx:478`, replace the inline `Object.values(productSummary.reduce(...))` expression with `categorySummary`:

```js
            {(subTab === 'products' ? productSummary : categorySummary).map((row) => <tr key={`${row.category}-${row.product || ''}`}>{subTab === 'products' && <td>{row.product}</td>}<td>{row.category}</td><td>{row.quantity}</td><td>{peso(row.revenue)}</td></tr>)}
```

- [ ] **Step 5: Manually verify no behavior change**

Run `npm run dev`, open Transaction Logs, and confirm:
- The main transaction table still shows the same rows as before.
- "Product Summary" and "Category Summary" tabs still show the same quantities/revenue as before this refactor (spot-check a few rows against what you remember, or compare against a `git stash`d copy if unsure).

- [ ] **Step 6: Run the full offline test suite to catch regressions**

Run: `npm run test:offline`
Expected: PASS (no change expected — this task doesn't touch tested logic, but confirms nothing else broke)

- [ ] **Step 7: Commit**

```bash
git add src/admin-page/pages/TransactionLogs.jsx
git commit -m "refactor: reuse shared receipt aggregation utilities in Transaction Logs"
```

---

### Task 4: Add `safeFilenamePart` to the shared export util

**Files:**
- Modify: `src/admin-page/utils/exportCsv.js` (add and export `safeFilenamePart`)
- Modify: `src/admin-page/pages/TransactionLogs.jsx` (remove the local copy, import the shared one)
- Test: `tests/export-csv-filename.test.js`

**Interfaces:**
- Produces: `safeFilenamePart(value) => string` — strips a value down to `[A-Za-z0-9_-]`, collapsing repeats and trimming leading/trailing dashes, falling back to `'transaction'` when empty. Used by Task 5's CSV export.

`TransactionLogs.jsx:82-87` already has this exact function as a private helper. Extracting it avoids a second near-duplicate copy for Task 5's export filenames.

- [ ] **Step 1: Write the failing test**

Create `tests/export-csv-filename.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { safeFilenamePart } from '../src/admin-page/utils/exportCsv.js'

test('safeFilenamePart strips unsafe characters', () => {
  assert.equal(safeFilenamePart('Arlie Velasco / Cashier #1'), 'Arlie-Velasco-Cashier-1')
})

test('safeFilenamePart collapses repeated separators and trims edges', () => {
  assert.equal(safeFilenamePart('  --weird//name--  '), 'weird-name')
})

test('safeFilenamePart falls back to "transaction" for empty input', () => {
  assert.equal(safeFilenamePart(''), 'transaction')
  assert.equal(safeFilenamePart(undefined), 'transaction')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/export-csv-filename.test.js`
Expected: FAIL — `safeFilenamePart` is not exported

- [ ] **Step 3: Add `safeFilenamePart` to `src/admin-page/utils/exportCsv.js`**

Add this function to the file (near the top, alongside the other small helpers) and export it:

```js
export function safeFilenamePart(value) {
  return String(value || 'transaction')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/export-csv-filename.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Update `TransactionLogs.jsx` to use the shared function**

In `src/admin-page/pages/TransactionLogs.jsx`:
- Remove the local `safeFilenamePart` function (lines 82-87).
- Add `safeFilenamePart` to the existing `import { exportCsv } from '../utils/exportCsv'` line, making it `import { exportCsv, safeFilenamePart } from '../utils/exportCsv'`.

- [ ] **Step 6: Manually verify reprint/download filenames still work**

Run `npm run dev`, open Transaction Logs, download a receipt PDF or export a single transaction, and confirm the filename still looks sane (e.g. `TXN-0001-receipt.pdf`).

- [ ] **Step 7: Commit**

```bash
git add src/admin-page/utils/exportCsv.js src/admin-page/pages/TransactionLogs.jsx tests/export-csv-filename.test.js
git commit -m "refactor: share safeFilenamePart via exportCsv util"
```

---

### Task 5: Build the `CashierSalesReport` component

**Files:**
- Create: `src/admin-page/pages/CashierSalesReport.jsx`

**Interfaces:**
- Consumes:
  - `api.receipts({ cashierName, fromDate, toDate })`, `api.cashiers()`, `api.categories()`, `api.products()` from `../services/api` (all already exist; `receipts` filter params already existed, Task 1 only makes `fromDate`/`toDate` cheaper server-side).
  - `resolveReceiptCategories`, `summarizeSalesByProduct`, `summarizeByCategory`, `filterReceiptsByProductCategory` from `../utils/receiptSalesUtils` (Task 2).
  - `exportCsv`, `safeFilenamePart` from `../utils/exportCsv` (Task 4).
  - `exportLocationKeys`, `getExportLocation` from `../utils/exportSettings`.
  - `peso` from `../services/api`.
- Produces: `export default function CashierSalesReport({ dateRangeFilter, dataSource })` where `dateRangeFilter` is `{ from: string, to: string }` (empty strings mean "all time") — a React component with no other exports. Consumed by Task 6.

No `node:test` coverage for this file — matches the existing repo convention that `.jsx` page components aren't unit-tested (only the pure logic they call is, which Task 2 and Task 4 already cover). Verify this task by running the app (Task 6 wires it into a real tab, so verification happens there).

- [ ] **Step 1: Create the component**

```jsx
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
```

- [ ] **Step 2: Commit**

```bash
git add src/admin-page/pages/CashierSalesReport.jsx
git commit -m "feat: add CashierSalesReport component"
```

---

### Task 6: Wire the new tab into `Analytics.jsx`

**Files:**
- Modify: `src/admin-page/pages/Analytics.jsx`

**Interfaces:**
- Consumes: `CashierSalesReport` (default export) from `./CashierSalesReport` (Task 5), taking props `{ dateRangeFilter: { from, to }, dataSource }`.

- [ ] **Step 1: Import the new component**

Add near the top of `src/admin-page/pages/Analytics.jsx`:

```js
import CashierSalesReport from './CashierSalesReport'
```

- [ ] **Step 2: Lift the date-range computation out of the existing effect**

Currently `Analytics.jsx:80-93` computes `filters.from`/`filters.to` inline inside the `useEffect` that calls `api.dashboard`. Add a memoized version above that effect so it can also be passed to the new tab:

```js
  const dateRangeFilter = useMemo(() => {
    const now = new Date()
    const fromDate = new Date(now)
    if (datePreset !== 'all' && datePreset !== 'custom') fromDate.setDate(fromDate.getDate() - (Number(datePreset) - 1))
    return {
      from: datePreset === 'custom' ? customFrom : (datePreset === 'all' ? '' : localDateKey(fromDate)),
      to: datePreset === 'custom' ? customTo : (datePreset === 'all' ? '' : localDateKey(now)),
    }
  }, [customFrom, customTo, datePreset])
```

Add `useMemo` to the existing `import { useEffect, useState } from 'react'` line, making it `import { useEffect, useMemo, useState } from 'react'`.

Then simplify the existing effect (`Analytics.jsx:80-93`) to reuse it:

```js
  useEffect(() => {
    const filters = { source: dataSource, from: dateRangeFilter.from, to: dateRangeFilter.to }
    void api.dashboard(filters).then((result) => {
      setData(result)
      setLastUpdated(new Date().toISOString())
    })
  }, [dataSource, dateRangeFilter, setData])
```

- [ ] **Step 3: Add the third tab button**

At `Analytics.jsx:166-169`, add a third tab button next to "Sales Analytics" and "Inventory Movement":

```jsx
      <div className="scan-mode-row analytics-tabs analytics-tabs-sticky" role="tablist" aria-label="Analytics sections">
        <button type="button" className={`scan-mode ${analyticsTab === 'sales' ? 'active' : ''}`} onClick={() => setAnalyticsTab('sales')} role="tab" aria-selected={analyticsTab === 'sales'}>Sales Analytics</button>
        <button type="button" className={`scan-mode ${analyticsTab === 'movement' ? 'active' : ''}`} onClick={() => setAnalyticsTab('movement')} role="tab" aria-selected={analyticsTab === 'movement'}>Inventory Movement</button>
        <button type="button" className={`scan-mode ${analyticsTab === 'cashier' ? 'active' : ''}`} onClick={() => setAnalyticsTab('cashier')} role="tab" aria-selected={analyticsTab === 'cashier'}>By Cashier</button>
      </div>
```

- [ ] **Step 4: Render the tab content**

After the existing `{analyticsTab === 'movement' && (...)}` block (`Analytics.jsx:277-342`), add:

```jsx
      {analyticsTab === 'cashier' && (
        <CashierSalesReport dateRangeFilter={dateRangeFilter} dataSource={dataSource} />
      )}
```

Because this is a plain conditional render (not a route), `CashierSalesReport` only mounts — and only then fetches its lightweight cashier/category/product option lists — when the owner actually clicks the "By Cashier" tab. Switching away and back remounts it (small refetch of those lightweight lists, no receipts refetch since that only happens on "Show Report").

- [ ] **Step 5: Manually verify in the running app**

Run `npm run dev`, log in as admin, open Analytics:
1. Confirm "Sales Analytics" and "Inventory Movement" tabs behave exactly as before (no regression from the `dateRangeFilter` refactor in Step 2).
2. Click "By Cashier". Confirm no network request fires for receipts yet (check devtools Network tab) — only cashier/category/product option requests.
3. Pick a specific cashier (e.g. one you've processed a test sale as), leave Category/Product as "All", click "Show Report". Confirm the table shows that cashier's products/categories with correct quantities and revenue.
4. Switch the group-by toggle between "By Product" and "By Category" and confirm totals stay consistent.
5. Change the Category or Product dropdown — confirm the table updates immediately without a new network request (client-side filtering, no refetch).
6. Change the date range (top of Analytics page) after already generating a report — confirm the "Filters changed — click Show Report to refresh" banner appears, and the table only updates after clicking "Show Report" again.
7. Click "Export CSV" and confirm a CSV downloads/saves with the expected cashier, date range, and rows.

- [ ] **Step 6: Run the full offline test suite**

Run: `npm run test:offline`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/admin-page/pages/Analytics.jsx
git commit -m "feat: add By Cashier tab to Analytics"
```

---

### Task 7: Register new tests in `test:offline`

**Files:**
- Modify: `package.json`

**Interfaces:** None — this only affects which files the `test:offline` script runs.

- [ ] **Step 1: Add the two new test files to the script**

In `package.json`, find the `test:offline` script (currently ends with `...tests/transaction-log-sort.test.js"`) and append the two new test files:

```
... tests/transaction-log-sort.test.js tests/receipt-sales-utils.test.js tests/export-csv-filename.test.js
```

- [ ] **Step 2: Run the full script to confirm everything passes together**

Run: `npm run test:offline`
Expected: PASS (all existing tests plus the new `receipt-sales-utils` and `export-csv-filename` tests)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: register cashier sales report unit tests in test:offline"
```

---

## Known limitations (intentional, out of scope for this plan)

- The Cashier dropdown is sourced from currently-registered staff (`api.cashiers()`), not from sales history — a cashier who sold in the past but has since been removed from staff won't appear as a filter option. Transaction Logs' own cashier dropdown has broader coverage (it also merges names seen in receipts) precisely because it already pays the cost of a full receipts fetch; this report deliberately doesn't.
- Selecting "All Time" as the date range still triggers a full, unscoped `/api/receipts` fetch when "Show Report" is clicked (Task 1's server-side filter only helps when a concrete date range is set). This matches how "All Time" already behaves everywhere else in the app.
