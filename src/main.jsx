import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import { applyTheme, getStoredTheme } from './utils/themeSettings.js'
import './global.css'

applyTheme(getStoredTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      {React.createElement(
        import.meta.env.VITE_APP_TARGET === 'cashier-desktop'
          ? DesktopApp
          : App,
      )}
    </AppErrorBoundary>
  </React.StrictMode>,
)
