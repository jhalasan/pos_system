import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Envelope, Eye, EyeSlash, Cart } from 'react-bootstrap-icons';
import { cashierApi } from '../services/api';
import styles from '../styles/CashierLogin.module.css';

const CashierLogin = ({ onLogin }) => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quickAccounts, setQuickAccounts] = useState([]);

  useEffect(() => {
    let ignore = false;

    async function loadQuickAccounts() {
      try {
        const accounts = await cashierApi.quickLoginAccounts();
        if (!ignore) setQuickAccounts(accounts);
      } catch {
        if (!ignore) setQuickAccounts([]);
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
        <p className={styles['login-subtitle']}>Enter your credentials to access the POS</p>

        {/* Form */}
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
                      {account.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}
                    </span>
                    <span>
                      <strong>{account.name}</strong>
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
      </div>
    </div>
  );
};

export default CashierLogin;
