import React from 'react';

const Card = ({
  children,
  className = '',
  title,
  subtitle,
  padding = 'lg',
  shadow = true,
  ...props
}) => {
  const paddingClass = padding ? `card-p-${padding}` : 'card-p-lg';
  const shadowClass = shadow ? 'card-shadow' : '';
  
  return (
    <div className={`card ${paddingClass} ${shadowClass} ${className}`.trim()} {...props}>
      {(title || subtitle) && (
        <div className="card-header">
          {title && <h3 className="card-title">{title}</h3>}
          {subtitle && <p className="card-subtitle">{subtitle}</p>}
        </div>
      )}
      <div className="card-content">
        {children}
      </div>
    </div>
  );
};

export default Card;
