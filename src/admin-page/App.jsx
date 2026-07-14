import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { isAuthed } from './auth'
import AdminLayout from './components/AdminLayout'
import RoleSelect from './pages/RoleSelect'
import BrandedLoader from '../components/BrandedLoader'

const Login = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Inventory = lazy(() => import('./pages/Inventory'))
const ProductManagement = lazy(() => import('./pages/ProductManagement'))
const BarcodeTools = lazy(() => import('./pages/BarcodeTools'))
const CashierManagement = lazy(() => import('./pages/CashierManagement'))
const Analytics = lazy(() => import('./pages/Analytics'))
const TransactionLogs = lazy(() => import('./pages/TransactionLogs'))
const ActivityLogs = lazy(() => import('./pages/ActivityLogs'))
const Audit = lazy(() => import('./pages/Audit'))
const Settings = lazy(() => import('./pages/Settings'))

function RequireAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Suspense fallback={<BrandedLoader message="Opening admin tools…" />}>
    <Routes>
      <Route path="/" element={<RoleSelect />} />
      <Route path="/login" element={<Login />} />

      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
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

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
