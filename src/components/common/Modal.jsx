import React, { useState } from 'react';
import { XLg } from 'react-bootstrap-icons';
import styles from './Modal.module.css';

const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeButton = true,
  className = '',
}) => {
  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleEscapeKey = (e) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  React.useEffect(() => {
    window.addEventListener('keydown', handleEscapeKey);
    return () => window.removeEventListener('keydown', handleEscapeKey);
  }, []);

  const sizeClass = styles[`modal-${size}`] || styles['modal-md'];
  
  return (
    <div className={styles['modal-overlay']} onClick={handleBackdropClick}>
      <div className={`${styles.modal} ${sizeClass} ${className}`}>
        {(title || closeButton) && (
          <div className={styles['modal-header']}>
            {title && <h2 className={styles['modal-title']}>{title}</h2>}
            {closeButton && (
              <button
                className={styles['modal-close']}
                onClick={onClose}
                aria-label="Close modal"
              >
                <XLg size={20} />
              </button>
            )}
          </div>
        )}
        <div className={styles['modal-body']}>
          {children}
        </div>
        {footer && (
          <div className={styles['modal-footer']}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
