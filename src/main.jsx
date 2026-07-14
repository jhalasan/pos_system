import React from 'react'
import ReactDOM from 'react-dom/client'
import AppTarget from '@app-target'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import CapsLockDetector from './components/CapsLockDetector.jsx'
import { applyTheme, getStoredTheme } from './utils/themeSettings.js'
import './global.css'

applyTheme(getStoredTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppTarget />
      <CapsLockDetector />
    </AppErrorBoundary>
  </React.StrictMode>,
)

if (import.meta.env.VITE_APP_TARGET === 'cashier-desktop') {
  window.setTimeout(() => {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
    invoke?.('complete_startup').catch(() => {})
  }, 650)
}
