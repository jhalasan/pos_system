import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Envelope, Eye, EyeSlash, Cart, UpcScan } from 'react-bootstrap-icons';
import { cashierApi } from '../services/api';
import styles from '../styles/CashierLogin.module.css';

const QUICK_LOGIN_CACHE_KEY = 'nexa_cashier_quick_accounts';

function displayName(account) {
  const email = String(account?.email || '').trim();
  const name = String(account?.name || '').trim();
  return name || email.split('@')[0] || 'Cashier';
}

function initialsFor(account) {
  return displayName(account)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2) || 'C';
}

const CashierLogin = ({ onLogin }) => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [barcode, setBarcode] = useState('');
  const [password, setPassword] = useState('');
  const [loginMode, setLoginMode] = useState('barcode');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quickAccounts, setQuickAccounts] = useState([]);

  function cachedQuickAccounts() {
    try {
      return JSON.parse(localStorage.getItem(QUICK_LOGIN_CACHE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  useEffect(() => {
    let ignore = false;

    async function loadQuickAccounts() {
      try {
        const accounts = await cashierApi.quickLoginAccounts();
        if (!ignore) {
          const normalized = (Array.isArray(accounts) ? accounts : []).filter((account) => String(account?.email || '').trim());
          if (normalized.length > 0) {
            localStorage.setItem(QUICK_LOGIN_CACHE_KEY, JSON.stringify(normalized));
            setQuickAccounts(normalized);
          } else {
            setQuickAccounts(cachedQuickAccounts());
          }
        }
      } catch {
        if (!ignore) setQuickAccounts(cachedQuickAccounts());
      }
    }

    loadQuickAccounts();
    return () => { ignore = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!password.trim()) {
      setError('Password is required');
      return;
    }

    setLoading(true);
    try {
      const session = await cashierApi.login(email, password);
      onLogin(session.user);
      navigate('/cashier', { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  const handleBarcodeLogin = async (e) => {
    e.preventDefault();
    setError('');

    if (!barcode.trim()) {
      setError('Cashier barcode is required');
      return;
    }

    setLoading(true);
    try {
      const session = await cashierApi.loginWithBarcode(barcode);
      onLogin(session.user);
      navigate('/cashier', { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid cashier barcode');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles['login-container']}>
      <div className={styles['login-card']}>
        {/* Logo */}
        <div className={styles['logo-container']}>
          <div className={styles['logo-icon']}>
            <Envelope size={40} />
          </div>
        </div>

        {/* Heading */}
        <h1 className={styles['login-title']}>Cashier Login</h1>
        <p className={styles['login-subtitle']}>
          {loginMode === 'barcode' ? 'Scan your cashier barcode to access the POS' : 'Use your cashier email and password'}
        </p>

        <div className={styles['login-mode-toggle']} role="radiogroup" aria-label="Login method">
          <label className={loginMode === 'barcode' ? styles.active : ''}>
            <input
              type="radio"
              name="cashier-login-mode"
              value="barcode"
              checked={loginMode === 'barcode'}
              onChange={() => {
                setLoginMode('barcode');
                setError('');
              }}
            />
            Barcode
          </label>
          <label className={loginMode === 'email' ? styles.active : ''}>
            <input
              type="radio"
              name="cashier-login-mode"
              value="email"
              checked={loginMode === 'email'}
              onChange={() => {
                setLoginMode('email');
                setError('');
              }}
            />
            Email
          </label>
        </div>

        {loginMode === 'barcode' && (
        <form onSubmit={handleBarcodeLogin} className={styles['login-form']}>
          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Cashier Barcode</label>
            <div className={styles['password-wrapper']}>
              <input
                type="text"
                className={styles['form-input']}
                placeholder="Scan cashier barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                disabled={loading}
                autoFocus
              />
              <span className={styles['password-toggle']} aria-hidden="true">
                <UpcScan size={18} />
              </span>
            </div>
          </div>

          {error && <div className={styles['error-message']}>{error}</div>}

          <button type="submit" className={styles['login-button']} disabled={loading}>
            <UpcScan size={18} />
            {loading ? 'Logging in...' : 'Login with Barcode'}
          </button>
          <button
            type="button"
            className={styles['back-button']}
            onClick={() => navigate('/')}
          >
            Back to Role Selection
          </button>
        </form>
        )}

        {loginMode === 'email' && (
        <form onSubmit={handleSubmit} className={styles['login-form']}>
          {quickAccounts.length > 0 && (
            <div className={styles['quick-login-section']}>
              <div className={styles['quick-login-title']}>Quick Login</div>
              <div className={styles['quick-login-list']}>
                {quickAccounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    className={`${styles['quick-login-account']} ${email === account.email ? styles.active : ''}`}
                    onClick={() => {
                      setEmail(account.email);
                      setError('');
                    }}
                    disabled={loading}
                  >
                    <span className={styles['quick-login-avatar']}>
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

          {/* Email Field */}
          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Email</label>
            <input
              type="email"
              className={styles['form-input']}
              placeholder="Enter cashier email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
            />
          </div>

          {/* Password Field */}
          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Password</label>
            <div className={styles['password-wrapper']}>
              <input
                type={showPassword ? 'text' : 'password'}
                className={styles['form-input']}
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                className={styles['password-toggle']}
                onClick={() => setShowPassword(!showPassword)}
                tabIndex="-1"
              >
                {showPassword ? <EyeSlash size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && <div className={styles['error-message']}>{error}</div>}

          {/* Login Button */}
          <button
            type="submit"
            className={styles['login-button']}
            disabled={loading}
          >
            <Cart size={18} />
            {loading ? 'Logging in...' : 'Login'}
          </button>
          <button
            type="button"
            className={styles['back-button']}
            onClick={() => navigate('/')}
          >
            Back to Role Selection
          </button>
        </form>
        )}
      </div>
    </div>
  );
};

export default CashierLogin;
