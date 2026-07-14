import { Component, lazy, Suspense, useState } from 'react'
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import RoleSelection from './pages/RoleSelection'
import { isAuthed, logout as logoutAdminSession } from './admin-page/auth'
import AdminLayout from './admin-page/components/AdminLayout'
import BrandedLoader from './components/BrandedLoader'
import DesktopUpdater from './components/DesktopUpdater'
import { cashierApi } from './cashier-pos/services/api'
import './admin-page/index.css'

const CASHIER_AUTH_KEY = 'nexa_cashier_auth'
const AdminLogin = lazy(() => import('./admin-page/pages/Login'))
const Dashboard = lazy(() => import('./admin-page/pages/Dashboard'))
const Inventory = lazy(() => import('./admin-page/pages/Inventory'))
const ProductManagement = lazy(() => import('./admin-page/pages/ProductManagement'))
const BarcodeTools = lazy(() => import('./admin-page/pages/BarcodeTools'))
const CashierManagement = lazy(() => import('./admin-page/pages/CashierManagement'))
const Analytics = lazy(() => import('./admin-page/pages/Analytics'))
const TransactionLogs = lazy(() => import('./admin-page/pages/TransactionLogs'))
const Audit = lazy(() => import('./admin-page/pages/Audit'))
const ActivityLogs = lazy(() => import('./admin-page/pages/ActivityLogs'))
const Settings = lazy(() => import('./admin-page/pages/Settings'))
const CashierLogin = lazy(() => import('./cashier-pos/pages/CashierLogin'))
const Cashier = lazy(() => import('./cashier-pos/pages/Cashier'))

function RequireAdminAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/admin-login" replace />
}

class DesktopErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Desktop application render failed.', error, info)
  }

  recover = () => {
    logoutAdminSession()
    sessionStorage.removeItem(CASHIER_AUTH_KEY)
    window.location.hash = '#/'
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="desktop-error-screen">
        <div>
          <h2>Unable to open the POS screen</h2>
          <p>{this.state.error?.message || 'An unexpected application error occurred.'}</p>
          <button type="button" className="btn btn-primary" onClick={this.recover}>Return to Login</button>
        </div>
      </div>
    )
  }
}

export default function DesktopApp() {
  const [cashierUser, setCashierUser] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(CASHIER_AUTH_KEY) || 'null')
    } catch {
      return null
    }
  })

  const handleLogin = (user) => {
    sessionStorage.setItem(CASHIER_AUTH_KEY, JSON.stringify(user))
    setCashierUser(user)
  }

  const handleLogout = () => {
    sessionStorage.removeItem(CASHIER_AUTH_KEY)
    cashierApi.logout?.()
    setCashierUser(null)
  }

  return (
    <DesktopErrorBoundary>
    <DesktopUpdater />
    <Router>
      <Suspense fallback={<BrandedLoader message="Opening screen…" />}>
      <Routes>
        <Route path="/" element={<RoleSelection />} />
        <Route
          path="/admin-login"
          element={isAuthed() ? <Navigate to="/admin/dashboard" replace /> : <AdminLogin />}
        />
        <Route
          path="/admin"
          element={(
            <RequireAdminAuth>
              <AdminLayout />
            </RequireAdminAuth>
          )}
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="products" element={<ProductManagement />} />
          <Route path="barcodes" element={<BarcodeTools />} />
          <Route path="cashiers" element={<CashierManagement />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="gcash-payments" element={<Navigate to="/admin/transaction-logs" replace />} />
          <Route path="transaction-logs" element={<TransactionLogs />} />
          <Route path="audit" element={<Audit />} />
          <Route path="receipts" element={<Navigate to="transaction-logs" replace />} />
          <Route path="logs" element={<ActivityLogs />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route
          path="/login"
          element={cashierUser
            ? <Navigate to="/cashier" replace />
            : <CashierLogin onLogin={handleLogin} />}
        />
        <Route
          path="/cashier"
          element={cashierUser
            ? <Cashier onLogout={handleLogout} user={cashierUser} />
            : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to={isAuthed() ? '/admin/dashboard' : (cashierUser ? '/cashier' : '/login')} replace />} />
      </Routes>
      </Suspense>
    </Router>
    </DesktopErrorBoundary>
  )
}
