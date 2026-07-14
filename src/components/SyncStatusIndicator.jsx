import { useEffect, useState } from 'react'

const defaultMessages = {
  running: 'Auto-Sync Running',
  succeeded: 'Auto-Sync Succeeded',
  waiting: 'Auto-Sync Waiting to Retry',
  'auth-required': 'Cashier Online Login Required',
  offline: 'Auto-Sync Waiting for Connection',
  failed: 'Auto-Sync Failed',
}

export default function SyncStatusIndicator({ scope }) {
  const [status, setStatus] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(`nexa_sync_status_${scope}`) || 'null')
    } catch {
      return null
    }
  })

  useEffect(() => {
    function handleStatus(event) {
      const detail = event.detail || {}
      if (detail.scope !== scope) return

      const nextStatus = {
        state: detail.state || 'running',
        message: detail.message || defaultMessages[detail.state] || 'Auto-Sync Running',
        updatedAt: new Date().toISOString(),
      }
      setStatus(nextStatus)
      localStorage.setItem(`nexa_sync_status_${scope}`, JSON.stringify(nextStatus))
    }

    globalThis.addEventListener?.('nexa-sync-status', handleStatus)
    return () => globalThis.removeEventListener?.('nexa-sync-status', handleStatus)
  }, [scope])

  useEffect(() => {
    if (!status || status.state === 'running' || ['offline', 'failed', 'waiting', 'auth-required'].includes(status.state)) return undefined

    const timeoutId = window.setTimeout(() => {
      setStatus(null)
      localStorage.removeItem(`nexa_sync_status_${scope}`)
    }, 5000)
    return () => window.clearTimeout(timeoutId)
  }, [scope, status])

  if (!status) return null

  return (
    <div className={`sync-indicator sync-indicator-${scope} ${status.state}`.trim()}>
      <span className="sync-indicator-dot" />
      <span>{status.message}</span>
    </div>
  )
}
