import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './Icons'

export default function Modal({ title, onClose, children, footer, className = '' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal((
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className={`modal ${className}`.trim()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  ), document.body)
}
