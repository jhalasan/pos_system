import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { AppDialogProvider } from '../components/AppDialogProvider.jsx'
import { applyTheme, getStoredTheme } from '../utils/themeSettings.js'
import { disableNumberInputWheelChanges } from '../utils/numberInputWheel.js'
import './index.css'

applyTheme(getStoredTheme())
disableNumberInputWheelChanges()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppDialogProvider><App /></AppDialogProvider>
    </BrowserRouter>
  </React.StrictMode>
)
