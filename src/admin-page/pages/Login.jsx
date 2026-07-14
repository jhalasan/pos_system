import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../auth'
import { IconLock } from '../components/Icons'
import { api } from '../services/api'

const QUICK_LOGIN_CACHE_KEY = 'nexa_admin_quick_accounts'
const isAdminWeb = import.meta.env.VITE_APP_TARGET === 'admin-web'

function displayName(account) {
  const email = String(account?.email || '').trim()
  const name = String(account?.name || '').trim()
  return name || email.split('@')[0] || 'Admin'
}

function initialsFor(account) {
  return displayName(account)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2) || 'A'
}

export default function Login() {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [quickAccounts, setQuickAccounts] = useState([])

  function cachedQuickAccounts() {
    try {
      return JSON.parse(localStorage.getItem(QUICK_LOGIN_CACHE_KEY) || '[]')
    } catch {
      return []
    }
  }

  useEffect(() => {
    let ignore = false

    async function loadQuickAccounts() {
      try {
        const accounts = await api.adminQuickLoginAccounts()
        if (!ignore) {
          const normalized = (Array.isArray(accounts) ? accounts : []).filter((account) => String(account?.email || '').trim())
          if (normalized.length > 0) {
            localStorage.setItem(QUICK_LOGIN_CACHE_KEY, JSON.stringify(normalized))
            setQuickAccounts(normalized)
          } else {
            setQuickAccounts(cachedQuickAccounts())
          }
        }
      } catch {
        if (!ignore) setQuickAccounts(cachedQuickAccounts())
      }
    }

    if (!isAdminWeb) loadQuickAccounts()
    return () => { ignore = true }
  }, [])

  async function submit(e) {
    e.preventDefault()
    if (!email.trim()) {
      setError('Please enter your email.')
      return
    }
    if (!password.trim()) {
      setError('Please enter your password.')
      return
    }

    setLoading(true)
    setError('')
    try {
      await login(email, password)
      nav('/admin/dashboard', { replace: true })
    } catch (err) {
      setError(err.message || 'Incorrect password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="login-card">
        <img className="brand-logo-full" src="/branding/nexa-systems-logo-transparent.png" alt="NEXA Systems" />
        <h2>Admin Access</h2>
        <p className="tag">Enter your admin email and password to access the dashboard</p>

        <form className="login-form" onSubmit={submit}>
          {error && <div className="login-error">{error}</div>}

          {quickAccounts.length > 0 && (
            <div className="quick-login-section">
              <div className="quick-login-title">Quick Login</div>
              <div className="quick-login-list">
                {quickAccounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    className={'quick-login-account ' + (email === account.email ? 'active' : '')}
                    onClick={() => {
                      setEmail(account.email)
                      setError('')
                    }}
                    disabled={loading}
                  >
                    <span className="quick-login-avatar">
                      {initialsFor(account)}
                    </span>
                    <span>
                      <strong>{displayName(account)}</strong>
                      <small>{account.email}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="input"
              placeholder="Enter admin email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError('') }}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="pwd">Password</label>
            <input
              id="pwd"
              type="password"
              className="input"
              placeholder="Enter admin password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            <IconLock size={16} /> {loading ? 'Logging in...' : 'Login'}
          </button>

          <div className="text-center">
            <button
              type="button"
              className="link-btn"
              onClick={() => alert('Password reset should be handled by your admin process.')}
            >
              Forgot Password?
            </button>
          </div>
          {!isAdminWeb && <button
            type="button"
            className="admin-login-back"
            onClick={() => nav('/')}
          >
            Back to Role Selection
          </button>}
        </form>
      </div>
    </div>
  )
}
