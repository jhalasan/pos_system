import React from 'react'
import ReactDOM from 'react-dom/client'
import AppTarget from '@app-target'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import CapsLockDetector from './components/CapsLockDetector.jsx'
import { AppDialogProvider } from './components/AppDialogProvider.jsx'
import { applyTheme, getStoredTheme } from './utils/themeSettings.js'
import { disableNumberInputWheelChanges } from './utils/numberInputWheel.js'
import './global.css'

applyTheme(getStoredTheme())
disableNumberInputWheelChanges()

// Kept in the entry module because it reports this specific root's first commit.
// eslint-disable-next-line react-refresh/only-export-components
function BootReadySignal() {
  React.useEffect(() => {
    window.__NEXA_REACT_READY__ = true
    window.dispatchEvent(new Event('nexa-react-ready'))
  }, [])
  return null
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppDialogProvider>
        <BootReadySignal />
        <AppTarget />
        <CapsLockDetector />
      </AppDialogProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
)

if (import.meta.env.VITE_APP_TARGET === 'cashier-desktop') {
  window.setTimeout(() => {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
    invoke?.('complete_startup').catch(() => {})
  }, 650)
}
