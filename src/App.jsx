import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import CashierLogin from './cashier-pos/pages/CashierLogin';
import Cashier from './cashier-pos/pages/Cashier';
import './styles/global.module.css';

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
        {/* Login Route */}
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

        {/* Default Route */}
        <Route
          path="/"
          element={<Navigate to={isAuthenticated ? '/cashier' : '/login'} replace />}
        />

        {/* 404 Route */}
        <Route
          path="*"
          element={<Navigate to={isAuthenticated ? '/cashier' : '/login'} replace />}
        />
      </Routes>
    </Router>
  );
}

export default App;
