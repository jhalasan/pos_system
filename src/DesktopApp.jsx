import { useState } from 'react'
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import RoleSelection from './pages/RoleSelection'
import CashierLogin from './cashier-pos/pages/CashierLogin'
import Cashier from './cashier-pos/pages/Cashier'
import { isAuthed } from './admin-page/auth'
import AdminLayout from './admin-page/components/AdminLayout'
import AdminLogin from './admin-page/pages/Login'
import Dashboard from './admin-page/pages/Dashboard'
import Inventory from './admin-page/pages/Inventory'
import ProductManagement from './admin-page/pages/ProductManagement'
import BarcodeTools from './admin-page/pages/BarcodeTools'
import CashierManagement from './admin-page/pages/CashierManagement'
import Analytics from './admin-page/pages/Analytics'
import GCashPayments from './admin-page/pages/GCashPayments'
import ActivityLogs from './admin-page/pages/ActivityLogs'
import Settings from './admin-page/pages/Settings'
import './admin-page/index.css'

const CASHIER_AUTH_KEY = 'nexa_cashier_auth'

function RequireAdminAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/admin-login" replace />
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
    setCashierUser(null)
  }

  return (
    <Router>
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
          <Route path="gcash-payments" element={<GCashPayments />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  )
}
