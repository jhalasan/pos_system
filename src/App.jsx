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
import CashierManagement from './admin-page/pages/CashierManagement';
import Analytics from './admin-page/pages/Analytics';
import ActivityLogs from './admin-page/pages/ActivityLogs';
import './global.css';

function RequireAdminAuth({ children }) {
  return isAuthed() ? children : <Navigate to="/admin-login" replace />;
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [cashierUser, setCashierUser] = useState(null);

  const handleLogin = (user) => {
    setCashierUser(user);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
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
          <Route path="cashiers" element={<CashierManagement />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="logs" element={<ActivityLogs />} />
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
