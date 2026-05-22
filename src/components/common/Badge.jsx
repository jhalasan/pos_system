import React from 'react';

const Badge = ({
  children,
  variant = 'neutral',
  size = 'md',
  className = '',
  ...props
}) => {
  const variantClass = variant ? `badge-${variant}` : 'badge-neutral';
  
  return (
    <span className={`badge ${variantClass} ${className}`.trim()} {...props}>
      {children}
    </span>
  );
};

export default Badge;
