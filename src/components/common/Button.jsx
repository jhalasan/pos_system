import React from 'react';

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
  const variantClass = variant ? `btn-${variant}` : 'btn-primary';
  const sizeClass = size ? `btn-${size}` : 'btn-md';
  const fullWidthClass = fullWidth ? 'btn-block' : '';
  
  return (
    <button
      type={type}
      className={`btn ${variantClass} ${sizeClass} ${fullWidthClass} ${className}`.trim()}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {Icon && <Icon className="btn-icon" style={{ marginRight: '4px' }} />}
      {children}
    </button>
  );
};

export default Button;
