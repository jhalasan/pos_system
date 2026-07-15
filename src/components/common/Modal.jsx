import { useEffect, useRef } from 'react';
import { XLg } from 'react-bootstrap-icons';

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
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleEscapeKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscapeKey);
    return () => window.removeEventListener('keydown', handleEscapeKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    previousFocusRef.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      const modal = modalRef.current;
      const preferred = modal?.querySelector('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
        || modal?.querySelector('.modal-foot .btn-primary:not(:disabled), .modal-foot .btn-danger:not(:disabled)')
        || modal?.querySelector('button:not(:disabled)');
      preferred?.focus?.();
      preferred?.select?.();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen]);

  const handleModalKeyDown = (event) => {
    if (event.key === 'Tab') {
      const focusable = [...(modalRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target.closest('button, a, select, textarea, [contenteditable="true"]')) return;
    const primary = modalRef.current?.querySelector('.modal-foot .btn-primary:not(:disabled), .modal-foot .btn-danger:not(:disabled)');
    if (primary) {
      event.preventDefault();
      primary.click();
    }
  };

  if (!isOpen) return null;
  
  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div ref={modalRef} className={`modal modal-${size} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title || 'Dialog'} onKeyDown={handleModalKeyDown}>
        {(title || closeButton) && (
          <div className="modal-head">
            {title && <h3>{title}</h3>}
            {closeButton && (
              <button
                onClick={onClose}
                aria-label="Close modal"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <XLg size={20} />
              </button>
            )}
          </div>
        )}
        <div className="modal-body">
          {children}
        </div>
        {footer && (
          <div className="modal-foot">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
