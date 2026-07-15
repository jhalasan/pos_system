import { useEffect, useMemo, useState } from 'react'

function storedStatus(scope) {
  try { return JSON.parse(localStorage.getItem(`nexa_sync_status_${scope}`) || 'null') }
  catch { return null }
}

export default function ConnectionStatusBar({ scope = 'system', compact = false, cloudOnly = false, placement = 'default' }) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncStatus, setSyncStatus] = useState(() => (
    scope === 'system'
      ? storedStatus('cashier') || storedStatus('admin')
      : storedStatus(scope)
  ))

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    const handleSync = (event) => {
      const detail = event.detail || {}
      if (scope !== 'system' && detail.scope !== scope) return
      setSyncStatus({ state: detail.state, message: detail.message, updatedAt: new Date().toISOString() })
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('nexa-sync-status', handleSync)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('nexa-sync-status', handleSync)
    }
  }, [scope])

  useEffect(() => {
    if (syncStatus?.state !== 'succeeded') return undefined
    const timeoutId = window.setTimeout(() => {
      setSyncStatus(null)
      if (scope !== 'system') localStorage.removeItem(`nexa_sync_status_${scope}`)
    }, 5000)
    return () => window.clearTimeout(timeoutId)
  }, [scope, syncStatus])

  const status = useMemo(() => {
    if (cloudOnly) {
      return online
        ? { tone: 'online', label: 'Online', detail: 'Remote admin portal connected.' }
        : { tone: 'offline', label: 'Offline', detail: 'Remote changes require an internet connection.' }
    }
    if (!online || ['offline', 'auth-required'].includes(syncStatus?.state)) {
      return { tone: 'offline', label: 'Offline', detail: 'Changes are saved locally and will sync later.' }
    }
    if (syncStatus?.state === 'running') return { tone: 'syncing', label: 'Syncing', detail: syncStatus.message || 'Sending local changes to cloud.' }
    if (['failed', 'waiting'].includes(syncStatus?.state)) return { tone: 'warning', label: 'Sync pending', detail: syncStatus.message || 'Cloud sync will retry automatically.' }
    if (syncStatus?.state === 'succeeded') return { tone: 'success', label: 'Sync complete', detail: syncStatus.message || 'Everything is up to date.' }
    return { tone: 'online', label: 'Online', detail: syncStatus?.message || '' }
  }, [cloudOnly, online, syncStatus])

  if (placement === 'banner' && status.tone === 'online') return null

  return (
    <div className={`connection-status-bar ${status.tone}${compact || placement === 'header' ? ' compact' : ''}${placement === 'header' ? ' connection-status-pill' : ''}`} role="status">
      <span className="connection-status-dot" />
      <strong>{status.label}</strong>
      {!compact && status.detail && <span>{status.detail}</span>}
    </div>
  )
}
