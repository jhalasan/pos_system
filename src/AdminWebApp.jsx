import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { isAuthed } from './admin-page/auth'
import AdminLayout from './admin-page/components/AdminLayout'
import BrandedLoader from './components/BrandedLoader'
import './global.css'
import './admin-page/index.css'

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

function RequireAdminAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/admin-login" replace />
}

export default function AdminWebApp() {
  return (
    <BrowserRouter>
      <Suspense fallback={<BrandedLoader message="Opening remote admin portal…" />}>
        <Routes>
          <Route path="/" element={<Navigate to={isAuthed() ? '/admin/dashboard' : '/admin-login'} replace />} />
          <Route path="/admin-login" element={isAuthed()
            ? <Navigate to="/admin/dashboard" replace />
            : <AdminLogin />} />
          <Route path="/admin" element={<RequireAdminAuth><AdminLayout /></RequireAdminAuth>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="products" element={<ProductManagement />} />
            <Route path="barcodes" element={<BarcodeTools />} />
            <Route path="cashiers" element={<CashierManagement />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="transaction-logs" element={<TransactionLogs />} />
            <Route path="audit" element={<Audit />} />
            <Route path="logs" element={<ActivityLogs />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
