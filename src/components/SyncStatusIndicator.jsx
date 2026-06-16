import { useEffect, useState } from 'react'

const defaultMessages = {
  running: 'Auto-Sync Running',
  succeeded: 'Auto-Sync Succeeded',
  offline: 'Auto-Sync Waiting for Connection',
  failed: 'Auto-Sync Failed',
}

export default function SyncStatusIndicator({ scope }) {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    function handleStatus(event) {
      const detail = event.detail || {}
      if (detail.scope !== scope) return

      setStatus({
        state: detail.state || 'running',
        message: detail.message || defaultMessages[detail.state] || 'Auto-Sync Running',
      })
    }

    globalThis.addEventListener?.('nexa-sync-status', handleStatus)
    return () => globalThis.removeEventListener?.('nexa-sync-status', handleStatus)
  }, [scope])

  useEffect(() => {
    if (!status || status.state === 'running') return undefined

    const timeoutId = window.setTimeout(() => setStatus(null), 2600)
    return () => window.clearTimeout(timeoutId)
  }, [status])

  if (!status) return null

  return (
    <div className={`sync-indicator ${status.state}`.trim()}>
      <span className="sync-indicator-dot" />
      <span>{status.message}</span>
    </div>
  )
}
