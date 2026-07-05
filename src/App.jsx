import { lazy, Suspense, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import RoleSelection from './pages/RoleSelection';
import { isAuthed } from './admin-page/auth';
import AdminLayout from './admin-page/components/AdminLayout';
import './global.css';
import './admin-page/index.css';

const CASHIER_AUTH_KEY = 'nexa_cashier_auth';
const AdminLogin = lazy(() => import('./admin-page/pages/Login'));
const Dashboard = lazy(() => import('./admin-page/pages/Dashboard'));
const Inventory = lazy(() => import('./admin-page/pages/Inventory'));
const ProductManagement = lazy(() => import('./admin-page/pages/ProductManagement'));
const BarcodeTools = lazy(() => import('./admin-page/pages/BarcodeTools'));
const CashierManagement = lazy(() => import('./admin-page/pages/CashierManagement'));
const Analytics = lazy(() => import('./admin-page/pages/Analytics'));
const TransactionLogs = lazy(() => import('./admin-page/pages/TransactionLogs'));
const Audit = lazy(() => import('./admin-page/pages/Audit'));
const ActivityLogs = lazy(() => import('./admin-page/pages/ActivityLogs'));
const Settings = lazy(() => import('./admin-page/pages/Settings'));
const CashierLogin = lazy(() => import('./cashier-pos/pages/CashierLogin'));
const Cashier = lazy(() => import('./cashier-pos/pages/Cashier'));

function RequireAdminAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/admin-login" replace />;
}

function App() {
  const [cashierUser, setCashierUser] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(CASHIER_AUTH_KEY) || 'null');
    } catch {
      return null;
    }
  });
  const isAuthenticated = Boolean(cashierUser);

  const handleLogin = (user) => {
    sessionStorage.setItem(CASHIER_AUTH_KEY, JSON.stringify(user));
    setCashierUser(user);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(CASHIER_AUTH_KEY);
    setCashierUser(null);
  };

  return (
    <Router>
      <Suspense fallback={<div className="app-loading">Loading...</div>}>
      <Routes>
        {/* Role Selection Route */}
        <Route path="/" element={<RoleSelection />} />

        {/* Admin Login Route */}
        <Route
          path="/admin-login"
          element={
            isAuthed() ? (
              <Navigate to="/admin/dashboard" replace />
            ) : (
              <AdminLogin />
            )
          }
        />

        {/* Admin Routes */}
        <Route
          path="/admin"
          element={
            <RequireAdminAuth>
              <AdminLayout />
            </RequireAdminAuth>
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

        {/* Cashier Login Route */}
        <Route
          path="/login"
          element={
            isAuthenticated ? (
              <Navigate to="/cashier" replace />
            ) : (
              <CashierLogin onLogin={handleLogin} />
            )
          }
        />

        {/* Cashier POS Route */}
        <Route
          path="/cashier"
          element={
            isAuthenticated ? (
              <Cashier onLogout={handleLogout} user={cashierUser} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* 404 Route */}
        <Route
          path="*"
          element={<Navigate to="/" replace />}
        />
      </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
