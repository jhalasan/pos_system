import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../auth'
import { IconLock } from '../components/Icons'

export default function Login() {
  const nav = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function submit(e) {
    e.preventDefault()
    if (!password.trim()) {
      setError('Please enter your password.')
      return
    }
    if (login(password)) {
      nav('/admin/dashboard', { replace: true })
    } else {
      setError('Incorrect password. Please try again.')
    }
  }

  return (
    <div className="auth-wrap">
      <div className="login-card">
        <div className="brand-mark">N</div>
        <h2>Admin Access</h2>
        <p className="tag">Enter your password to access the admin dashboard</p>

        <form className="login-form" onSubmit={submit}>
          {error && <div className="login-error">{error}</div>}

          <div className="field">
            <label htmlFor="pwd">Password</label>
            <input
              id="pwd"
              type="password"
              className="input"
              placeholder="Enter admin password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              autoFocus
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block">
            <IconLock size={16} /> Login
          </button>

          <div className="text-center">
            <button
              type="button"
              className="link-btn"
              onClick={() => alert('Password reset would be handled by the backend.')}
            >
              Forgot Password?
            </button>
          </div>
          <div className="text-center">
            <button
              type="button"
              className="link-btn"
              onClick={() => nav('/')}
            >
              Back to Role Selection
            </button>
          </div>
        </form>

        <div className="login-hint">
          Demo password: <strong>admin123</strong>
        </div>
      </div>
    </div>
  )
}
