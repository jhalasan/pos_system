import { useCallback, useEffect, useState } from 'react'
import { MANUAL_UPDATE_CHECK_EVENT, UPDATE_CHECK_RESULT_EVENT } from '../utils/desktopUpdateEvents'

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

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
    const interval = window.setInterval(() => checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS)
    const handleManualCheck = () => checkForUpdate(true)
    const handleOnline = () => checkForUpdate(false)
    window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, handleManualCheck)
    window.addEventListener('online', handleOnline)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
      window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, handleManualCheck)
      window.removeEventListener('online', handleOnline)
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
    <div className="desktop-update-backdrop" role="presentation">
      <div className="desktop-update-notice" role="alertdialog" aria-modal="true" aria-labelledby="desktop-update-title" aria-describedby="desktop-update-message">
        <div className="desktop-update-icon" aria-hidden="true">↑</div>
        <div className="desktop-update-copy">
          <strong id="desktop-update-title">{update ? 'Nexa POS update available' : 'Software update'}</strong>
          <span id="desktop-update-message">{message}</span>
          {update && <small>Install the update to receive the latest fixes and improvements.</small>}
        </div>
        <div className="desktop-update-actions">
          {update && !['downloading'].includes(status) && (
            <button type="button" className="btn btn-primary" onClick={installUpdate} autoFocus>
              {status === 'deferred' ? 'Try after logout' : 'Download and install'}
            </button>
          )}
          {status !== 'downloading' && (
            <button type="button" className="btn btn-outline" onClick={() => { setUpdate(null); setStatus('idle'); setManual(false) }}>
              Remind me later
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
