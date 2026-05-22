import { Routes, Route, Navigate } from 'react-router-dom'
import { isAuthed } from './auth'
import AdminLayout from './components/AdminLayout'
import RoleSelect from './pages/RoleSelect'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Inventory from './pages/Inventory'
import ProductManagement from './pages/ProductManagement'
import CashierManagement from './pages/CashierManagement'
import Analytics from './pages/Analytics'
import ActivityLogs from './pages/ActivityLogs'

function RequireAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
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
        <Route path="cashiers" element={<CashierManagement />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="logs" element={<ActivityLogs />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
