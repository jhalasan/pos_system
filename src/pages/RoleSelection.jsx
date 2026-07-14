import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Cart3, ShieldLock } from 'react-bootstrap-icons';
import styles from './RoleSelection.module.css';
import SupportContactModal from '../components/SupportContactModal';
import ConnectionStatusBar from '../components/ConnectionStatusBar';
import { getTerminalId } from '../utils/terminalIdentity';

const LAST_WORKSPACE_KEY = 'nexa_last_workspace';

const RoleSelection = () => {
  const navigate = useNavigate();
  const [supportOpen, setSupportOpen] = useState(false);
  const [lastWorkspace, setLastWorkspace] = useState(() => localStorage.getItem(LAST_WORKSPACE_KEY) || '');

  const openWorkspace = useCallback((workspace) => {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspace);
    setLastWorkspace(workspace);
    navigate(workspace === 'admin' ? '/admin-login' : '/login');
  }, [navigate]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === '1') openWorkspace('admin');
      if (event.key === '2') openWorkspace('cashier');
      if (event.key === 'Enter' && lastWorkspace) openWorkspace(lastWorkspace);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lastWorkspace, openWorkspace]);

  return (
    <div className={styles['role-selection-container']}>
      <div className={styles['role-selection-content']}>
        <div className={styles['header']}>
          <div className={styles['brand-logo-frame']}>
            <img
              className={styles['brand-logo']}
              src="/branding/nexa-systems-logo-transparent.png"
              alt="NEXA Systems"
            />
          </div>
          <h1 className={styles['title']}>Point of Sale</h1>
          <p className={styles['subtitle']}>Choose your workspace to continue</p>
        </div>

        {/* Role Cards */}
        <div className={styles['role-cards']}>
          {/* Admin Card */}
          <div className={`${styles['role-card']} ${styles['admin-card']}`} role="button" tabIndex="0" onClick={() => openWorkspace('admin')} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); openWorkspace('admin'); } }}>
            <div className={styles['card-head']}>
              <span className={styles['workspace-label']}>Back Office {lastWorkspace === 'admin' && <b>Last used</b>}</span>
              <div className={styles['card-icon']}><ShieldLock size={30} /></div>
            </div>
            <h2 className={styles['card-title']}>Admin</h2>
            <p className={styles['card-description']}>
              Manage products, inventory, staff, reports, and system settings.
            </p>
            <div className={styles['feature-list']}><span>Inventory</span><span>Analytics</span><span>Staff</span></div>
            <button
              className={`${styles['card-button']} ${styles['admin-btn']}`}
              onClick={(event) => { event.stopPropagation(); openWorkspace('admin'); }}
            >
              Continue as Admin <span className={styles['shortcut-key']}>1</span> <ArrowRight size={17} />
            </button>
          </div>

          {/* Cashier Card */}
          <div className={`${styles['role-card']} ${styles['cashier-card']}`} role="button" tabIndex="0" onClick={() => openWorkspace('cashier')} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); openWorkspace('cashier'); } }}>
            <div className={styles['card-head']}>
              <span className={styles['workspace-label']}>Sales Terminal {lastWorkspace === 'cashier' && <b>Last used</b>}</span>
              <div className={styles['card-icon']}><Cart3 size={30} /></div>
            </div>
            <h2 className={styles['card-title']}>Cashier</h2>
            <p className={styles['card-description']}>
              Ring up sales, accept payments, print receipts, and serve customers.
            </p>
            <div className={styles['feature-list']}><span>Checkout</span><span>Receipts</span><span>Returns</span></div>
            <button
              className={`${styles['card-button']} ${styles['cashier-btn']}`}
              onClick={(event) => { event.stopPropagation(); openWorkspace('cashier'); }}
            >
              Open Cashier POS <span className={styles['shortcut-key']}>2</span> <ArrowRight size={17} />
            </button>
          </div>
        </div>

        <div className={styles['footer']}>
          <ConnectionStatusBar compact />
          <span className={styles['terminal-meta']}>{getTerminalId()} · v{import.meta.env.VITE_APP_VERSION}</span>
          <button className={styles['support-link']} onClick={() => setSupportOpen(true)}>Need help? Contact us</button>
        </div>
      </div>

      <SupportContactModal open={supportOpen} onClose={() => setSupportOpen(false)} source="Role Selection" />
    </div>
  );
};

export default RoleSelection;
