import React from 'react';
import styles from './Card.module.css';

const Card = ({
  children,
  className = '',
  title,
  subtitle,
  padding = 'lg',
  shadow = true,
  ...props
}) => {
  const paddingClass = styles[`card-p-${padding}`] || styles['card-p-lg'];
  const shadowClass = shadow ? styles['card-shadow'] : '';
  
  return (
    <div className={`${styles.card} ${paddingClass} ${shadowClass} ${className}`} {...props}>
      {(title || subtitle) && (
        <div className={styles['card-header']}>
          {title && <h3 className={styles['card-title']}>{title}</h3>}
          {subtitle && <p className={styles['card-subtitle']}>{subtitle}</p>}
        </div>
      )}
      <div className={styles['card-content']}>
        {children}
      </div>
    </div>
  );
};

export default Card;
