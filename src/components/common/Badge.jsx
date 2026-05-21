import React from 'react';
import styles from './Badge.module.css';

const Badge = ({
  children,
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}) => {
  const variantClass = styles[`badge-${variant}`] || styles['badge-default'];
  const sizeClass = styles[`badge-${size}`] || styles['badge-md'];
  return (
    <span className={`${styles.badge} ${variantClass} ${sizeClass} ${className}`} {...props}>
      {children}
    </span>
  );
};

export default Badge;
