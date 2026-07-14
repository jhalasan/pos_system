import { useEffect, useState } from 'react'

function isPasswordField(element) {
  return element instanceof HTMLInputElement && element.type === 'password'
}

export default function CapsLockDetector() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const update = (event) => {
      const field = isPasswordField(event.target)
        ? event.target
        : isPasswordField(document.activeElement)
          ? document.activeElement
          : null
      setVisible(Boolean(field && event.getModifierState?.('CapsLock')))
    }
    const handleFocus = (event) => {
      if (!isPasswordField(event.target)) setVisible(false)
    }
    const handleBlur = (event) => {
      if (isPasswordField(event.target)) setVisible(false)
    }

    document.addEventListener('keydown', update, true)
    document.addEventListener('keyup', update, true)
    document.addEventListener('focusin', handleFocus, true)
    document.addEventListener('focusout', handleBlur, true)
    return () => {
      document.removeEventListener('keydown', update, true)
      document.removeEventListener('keyup', update, true)
      document.removeEventListener('focusin', handleFocus, true)
      document.removeEventListener('focusout', handleBlur, true)
    }
  }, [])

  if (!visible) return null

  return (
    <div className="caps-lock-warning" role="status" aria-live="polite">
      <span aria-hidden="true">⇧</span>
      <strong>Caps Lock is on</strong>
    </div>
  )
}
