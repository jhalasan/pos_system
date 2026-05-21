import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  List,
  XLg,
  Cart,
  BoxArrowRight,
} from 'react-bootstrap-icons';
import styles from './Sidebar.module.css';

const Sidebar = () => {
  const [isOpen, setIsOpen] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  const navigationItems = [
    { label: 'Cashier POS', icon: Cart, path: '/cashier' },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <>
      <button
        className={styles['sidebar-toggle']}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Toggle sidebar"
      >
        {isOpen ? <XLg size={24} /> : <List size={24} />}
      </button>

      <aside className={`${styles.sidebar} ${isOpen ? styles.open : styles.closed}`}>
        <div className={styles['sidebar-header']}>
          <h1 className={styles['sidebar-title']}>Cashier POS</h1>
        </div>

        <nav className={styles['sidebar-nav']}>
          {navigationItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                className={`${styles['nav-item']} ${isActive(item.path) ? styles.active : ''}`}
                onClick={() => navigate(item.path)}
              >
                <Icon size={20} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className={styles['sidebar-actions']}>
          <button className={`${styles['action-btn']} ${styles.logout}`}>
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
