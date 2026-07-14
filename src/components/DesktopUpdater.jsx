import { useCallback, useEffect, useState } from 'react'
import { MANUAL_UPDATE_CHECK_EVENT, UPDATE_CHECK_RESULT_EVENT } from '../utils/desktopUpdateEvents'

function isCashierWorkspace() {
  return window.location.hash.startsWith('#/cashier')
}

export default function DesktopUpdater() {
  const [update, setUpdate] = useState(null)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [manual, setManual] = useState(false)

  const checkForUpdate = useCallback(async (requestedByUser = false) => {
    if (!window.__TAURI_INTERNALS__) return
    setManual(requestedByUser)
    setStatus('checking')
    setMessage('Checking for updates...')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const available = await check({ timeout: 30000 })
      setUpdate(available)
      setStatus(available ? 'available' : 'idle')
      setMessage(available
        ? `Version ${available.version} is ready to download.`
        : 'Nexa POS is up to date.')
      window.dispatchEvent(new CustomEvent(UPDATE_CHECK_RESULT_EVENT, {
        detail: { available: Boolean(available), version: available?.version || '', error: '' },
      }))
    } catch (error) {
      const detail = error?.message || String(error) || 'Unable to check for updates.'
      setStatus(requestedByUser ? 'error' : 'idle')
      setMessage(detail)
      window.dispatchEvent(new CustomEvent(UPDATE_CHECK_RESULT_EVENT, {
        detail: { available: false, version: '', error: detail },
      }))
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => checkForUpdate(false), 6000)
    const handleManualCheck = () => checkForUpdate(true)
    window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, handleManualCheck)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, handleManualCheck)
    }
  }, [checkForUpdate])

  async function installUpdate() {
    if (!update) return
    if (isCashierWorkspace()) {
      setMessage('Finish the current sale and log out before installing the update.')
      setStatus('deferred')
      return
    }

    setStatus('downloading')
    setMessage('Downloading and verifying the update...')
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Finished') setMessage('Installing update. Nexa POS will restart...')
      })
    } catch (error) {
      setStatus('error')
      setMessage(error?.message || 'The update could not be installed.')
    }
  }

  const visible = update || status === 'downloading' || status === 'deferred' || (manual && ['checking', 'error'].includes(status))
  if (!visible) return null

  return (
    <div className="desktop-update-notice" role="status" aria-live="polite">
      <div>
        <strong>{update ? 'Nexa POS update available' : 'Software update'}</strong>
        <span>{message}</span>
      </div>
      <div className="desktop-update-actions">
        {update && !['downloading'].includes(status) && (
          <button type="button" className="btn btn-primary btn-sm" onClick={installUpdate}>
            {status === 'deferred' ? 'Try after logout' : 'Download and install'}
          </button>
        )}
        {status !== 'downloading' && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { setUpdate(null); setStatus('idle'); setManual(false) }}>
            Later
          </button>
        )}
      </div>
    </div>
  )
}
