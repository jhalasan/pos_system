import React from 'react';

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
  return (
    <div className="field">
      {label && (
        <label>
          {label}
          {props.required && <span style={{ color: 'var(--danger)' }}>*</span>}
        </label>
      )}
      <div className="input-search" style={{ display: Icon ? 'block' : 'none' }}>
        {Icon && <Icon size={18} />}
        <input
          type={type}
          className={`input ${className}`.trim()}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...props}
        />
      </div>
      {!Icon && (
        <input
          type={type}
          className={`input ${className}`.trim()}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...props}
        />
      )}
      {error && <span style={{ color: 'var(--danger)', fontSize: '12px' }}>{error}</span>}
    </div>
  );
};

export default Input;
