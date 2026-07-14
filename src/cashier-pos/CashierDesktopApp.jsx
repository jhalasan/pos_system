import { lazy, Suspense, useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import BrandedLoader from '../components/BrandedLoader'

const CASHIER_AUTH_KEY = 'nexa_cashier_auth'
const Cashier = lazy(() => import('./pages/Cashier'))
const CashierLogin = lazy(() => import('./pages/CashierLogin'))

export default function CashierDesktopApp() {
  const [cashierUser, setCashierUser] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true

    import('./services/api')
      .then(({ cashierApi }) => cashierApi.currentUser())
      .then((user) => {
        if (!active) return
        setCashierUser(user)
        setReady(true)
      })
      .catch((error) => {
        console.error('Failed to initialize cashier runtime:', error)
        if (active) setReady(true)
      })

    return () => {
      active = false
    }
  }, [])

  const handleLogin = (user) => {
    sessionStorage.setItem(CASHIER_AUTH_KEY, JSON.stringify(user))
    setCashierUser(user)
  }

  const handleLogout = () => {
    sessionStorage.removeItem(CASHIER_AUTH_KEY)
    void import('./services/api').then(({ cashierApi }) => cashierApi.logout())
    setCashierUser(null)
  }

  if (!ready) return <BrandedLoader message="Opening cashier database…" />

  return (
    <HashRouter>
      <Suspense fallback={<BrandedLoader message="Opening cashier screen…" />}>
      <Routes>
        <Route
          path="/login"
          element={cashierUser
            ? <Navigate to="/cashier" replace />
            : <CashierLogin onLogin={handleLogin} />}
        />
        <Route
          path="/cashier"
          element={cashierUser
            ? <Cashier onLogout={handleLogout} user={cashierUser} />
            : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to={cashierUser ? '/cashier' : '/login'} replace />} />
      </Routes>
      </Suspense>
    </HashRouter>
  )
}
