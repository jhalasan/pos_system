import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cart } from 'react-bootstrap-icons';

const CashierLogin = ({ onLogin }) => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="auth-wrap">
      <div className="login-card">
        <div className="brand-mark">N</div>
        <h2>Cashier Login</h2>
        <p className="tag">Enter your credentials to access the POS system</p>

        <form className="login-form" onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}

          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              className="input"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError('');
              }}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={loading}
          >
            <Cart size={16} /> Login
          </button>

          <div className="text-center">
            <button
              type="button"
              className="link-btn"
              onClick={() => navigate('/')}
            >
              Back to Role Selection
            </button>
          </div>
        </form>

        <div className="login-hint">
          Demo credentials: <strong>cashier / cashier123</strong>
        </div>
      </div>
    </div>
  );
};

export default CashierLogin;
