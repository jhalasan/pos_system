import React from 'react';
import styles from './Button.module.css';

const Button = ({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  fullWidth = false,
  icon: Icon,
  onClick,
  className = '',
  type = 'button',
  ...props
}) => {
  const variantClass = styles[`btn-${variant}`] || styles['btn-primary'];
  const sizeClass = styles[`btn-${size}`] || styles['btn-md'];
  const fullWidthClass = fullWidth ? styles['btn-full-width'] : '';
  
  return (
    <button
      type={type}
      className={`${styles.btn} ${variantClass} ${sizeClass} ${fullWidthClass} ${className}`}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {Icon && <Icon className={styles['btn-icon']} />}
      {children}
    </button>
  );
};

export default Button;
