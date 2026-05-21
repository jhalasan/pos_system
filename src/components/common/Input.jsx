import React from 'react';
import styles from './Input.module.css';

const Input = ({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  disabled = false,
  error,
  icon: Icon,
  className = '',
  ...props
}) => {
  const inputClass = `${styles.input} ${Icon ? styles['input-with-icon'] : ''} ${error ? styles['input-error'] : ''}`;
  
  return (
    <div className={styles['input-container']}>
      {label && (
        <label className={styles['input-label']}>
          {label}
          {props.required && <span className={styles['input-required']}>*</span>}
        </label>
      )}
      <div className={styles['input-wrapper']}>
        {Icon && <Icon className={styles['input-icon']} />}
        <input
          type={type}
          className={`${inputClass} ${className}`}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...props}
        />
      </div>
      {error && <span className={styles['input-error-text']}>{error}</span>}
    </div>
  );
};

export default Input;
