import React from 'react';
import Sidebar from './Sidebar';
import styles from './MainLayout.module.css';

const MainLayout = ({ children, title }) => {
  return (
    <div className={styles['main-layout']}>
      <Sidebar />
      <main className={styles['main-content']}>
        {title && <h1 className={styles['page-title']}>{title}</h1>}
        {children}
      </main>
    </div>
  );
};

export default MainLayout;
