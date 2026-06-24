import { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import RoleSelection from './pages/RoleSelection';
import CashierLogin from './cashier-pos/pages/CashierLogin';
import Cashier from './cashier-pos/pages/Cashier';
import { isAuthed } from './admin-page/auth';
import AdminLayout from './admin-page/components/AdminLayout';
import AdminLogin from './admin-page/pages/Login';
import Dashboard from './admin-page/pages/Dashboard';
import Inventory from './admin-page/pages/Inventory';
import ProductManagement from './admin-page/pages/ProductManagement';
import BarcodeTools from './admin-page/pages/BarcodeTools';
import CashierManagement from './admin-page/pages/CashierManagement';
import Analytics from './admin-page/pages/Analytics';
import GCashPayments from './admin-page/pages/GCashPayments';
import TransactionLogs from './admin-page/pages/TransactionLogs';
import ActivityLogs from './admin-page/pages/ActivityLogs';
import Settings from './admin-page/pages/Settings';
import './global.css';
import './admin-page/index.css';

const CASHIER_AUTH_KEY = 'nexa_cashier_auth';

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
          <Route path="gcash-payments" element={<GCashPayments />} />
          <Route path="transaction-logs" element={<TransactionLogs />} />
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
    </Router>
  );
}

export default App;
