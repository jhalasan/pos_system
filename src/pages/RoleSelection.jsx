import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Person, PersonWorkspace } from 'react-bootstrap-icons';
import styles from './RoleSelection.module.css';
import SupportContactModal from '../components/SupportContactModal';

const RoleSelection = () => {
  const navigate = useNavigate();
  const [supportOpen, setSupportOpen] = useState(false);

  return (
    <div className={styles['role-selection-container']}>
      <div className={styles['role-selection-content']}>
        {/* Header */}
        <div className={styles['header']}>
          <div className={styles['logo']}>
            <PersonWorkspace size={48} />
          </div>
          <h1 className={styles['title']}>POS System</h1>
          <p className={styles['subtitle']}>Select your role to continue</p>
        </div>

        {/* Role Cards */}
        <div className={styles['role-cards']}>
          {/* Admin Card */}
          <div className={styles['role-card']}>
            <div className={styles['card-icon']}>
              <PersonWorkspace size={40} />
            </div>
            <h2 className={styles['card-title']}>Admin</h2>
            <p className={styles['card-description']}>
              Access dashboard, manage inventory, view analytics, and system settings
            </p>
            <button
              className={`${styles['card-button']} ${styles['admin-btn']}`}
              onClick={() => navigate('/admin-login')}
            >
              Login as Admin
            </button>
          </div>

          {/* Cashier Card */}
          <div className={styles['role-card']}>
            <div className={styles['card-icon']}>
              <Person size={40} />
            </div>
            <h2 className={styles['card-title']}>Cashier</h2>
            <p className={styles['card-description']}>
              Process sales, manage transactions, and handle customer payments
            </p>
            <button
              className={`${styles['card-button']} ${styles['cashier-btn']}`}
              onClick={() => navigate('/login')}
            >
              Login as Cashier
            </button>
          </div>
        </div>

        {/* Footer */}
        <button className={styles['support-link']} onClick={() => setSupportOpen(true)}>
          Need help? Contact us
        </button>
      </div>

      <SupportContactModal open={supportOpen} onClose={() => setSupportOpen(false)} source="Role Selection" />
    </div>
  );
};

export default RoleSelection;
