import { useCallback, useEffect, useState } from 'react'

export function useApi(loader, initialValue) {
  const [data, setData] = useState(initialValue)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await loader())
    } catch (err) {
      if (err.code === 'ADMIN_AUTH_REQUIRED') {
        // The admin shell was rendered (sessionStorage said "authed") but
        // the actual pb session could not be restored — rather than every
        // page independently showing "Unable to load", send the app back to
        // login once, centrally. AdminLayout owns the redirect since this
        // hook isn't router-aware.
        globalThis.dispatchEvent?.(new CustomEvent('nexa-admin-auth-required'))
      }
      setError(err.message || 'Unable to load data.')
    } finally {
      setLoading(false)
    }
  }, [loader])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { data, setData, loading, error, reload: load }
}
