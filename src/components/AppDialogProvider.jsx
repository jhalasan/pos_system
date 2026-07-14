import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const AppDialogContext = createContext(null)

export function AppDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const resolver = useRef(null)

  const open = useCallback((options) => new Promise((resolve) => {
    resolver.current?.(null)
    resolver.current = resolve
    setDialog({ type: 'alert', title: 'Notice', confirmLabel: 'OK', ...options })
  }), [])

  const close = useCallback((value) => {
    resolver.current?.(value)
    resolver.current = null
    setDialog(null)
  }, [])

  const api = {
    alert: (message, options = {}) => open({ ...options, message, type: 'alert' }),
    confirm: (message, options = {}) => open({ title: 'Please confirm', confirmLabel: 'Confirm', danger: true, ...options, message, type: 'confirm' }),
    prompt: (message, defaultValue = '', options = {}) => open({ title: 'Confirmation required', confirmLabel: 'Continue', ...options, message, defaultValue, type: 'prompt' }),
  }

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      {dialog && createPortal(
        <div className="app-dialog-overlay" role="presentation" onMouseDown={() => close(dialog.type === 'alert' ? true : null)}>
          <form className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
            event.preventDefault()
            const value = dialog.type === 'prompt' ? new FormData(event.currentTarget).get('dialogValue') : true
            close(value)
          }}>
            <div className={`app-dialog-icon ${dialog.danger ? 'danger' : ''}`} aria-hidden="true">{dialog.danger ? '!' : 'i'}</div>
            <div className="app-dialog-content">
              <h2 id="app-dialog-title">{dialog.title}</h2>
              <p>{dialog.message}</p>
              {dialog.type === 'prompt' && <input name="dialogValue" className="input" defaultValue={dialog.defaultValue} autoFocus autoComplete="off" />}
            </div>
            <div className="app-dialog-actions">
              {dialog.type !== 'alert' && <button type="button" className="btn btn-outline" onClick={() => close(null)}>Cancel</button>}
              <button type="submit" className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`} autoFocus={dialog.type !== 'prompt'}>{dialog.confirmLabel}</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </AppDialogContext.Provider>
  )
}

// The hook intentionally lives with its provider so dialog behavior has one source of truth.
// eslint-disable-next-line react-refresh/only-export-components
export function useAppDialog() {
  const context = useContext(AppDialogContext)
  if (!context) throw new Error('useAppDialog must be used inside AppDialogProvider')
  return context
}
