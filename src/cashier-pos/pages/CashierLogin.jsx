import React, { useState } from 'react';
import { Envelope, Eye, EyeSlash, Cart } from 'react-bootstrap-icons';
import styles from '../styles/CashierLogin.module.css';

const CashierLogin = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!username.trim()) {
      setError('Username is required');
      return;
    }
    if (!password.trim()) {
      setError('Password is required');
      return;
    }

    // Simulate API call
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      // TODO: Replace with database authentication after integration
      // Temporary demo credentials - username: cashier, password: cashier123
      if (username.toLowerCase() === 'cashier' && password === 'cashier123') {
        onLogin({ username });
      } else {
        setError('Invalid username or password');
      }
    }, 500);
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
          {/* Username Field */}
          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Username</label>
            <input
              type="text"
              className={styles['form-input']}
              placeholder="Enter Username Label"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
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
                placeholder="Enter Password Label"
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
        </form>
      </div>
    </div>
  );
};

export default CashierLogin;
