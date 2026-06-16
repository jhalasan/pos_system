import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'
import CashierDesktopApp from './cashier-pos/CashierDesktopApp.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import './global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      {React.createElement(
        import.meta.env.VITE_APP_TARGET === 'cashier-desktop'
          ? CashierDesktopApp
          : App,
      )}
    </AppErrorBoundary>
  </React.StrictMode>,
)
