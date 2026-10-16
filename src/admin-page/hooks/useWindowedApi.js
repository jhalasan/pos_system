import { useEffect, useRef, useState } from 'react'

// Like useApi, but for data that is fetched for a window (e.g. a date range)
// that the user can change. `loading` is true only until the first load
// settles, so a page's full-screen loader doesn't reappear on every range
// change; `stale` is true while a newer window is still loading, so the page
// can say its numbers are updating instead of showing a partial set as final.
// A response for a window that has since been replaced is discarded.
//
// `loader` should be stable for a given window (wrap it in useCallback keyed on
// the window); `windowKey` is that window as a string.
export function useWindowedApi(loader, windowKey, initialValue) {
  const [data, setData] = useState(initialValue)
  const [loading, setLoading] = useState(true)
  const [loadedKey, setLoadedKey] = useState(null)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current
    loader()
      .then((result) => {
        if (requestId !== requestRef.current) return
        setData(result)
        setError('')
      })
      .catch((err) => {
        if (requestId !== requestRef.current) return
        if (err?.code === 'ADMIN_AUTH_REQUIRED') {
          globalThis.dispatchEvent?.(new CustomEvent('nexa-admin-auth-required'))
        }
        setError(err?.message || 'Unable to load data.')
      })
      .finally(() => {
        if (requestId !== requestRef.current) return
        setLoadedKey(windowKey)
        setLoading(false)
      })
  }, [loader, windowKey])

  return { data, loading, error, stale: loadedKey !== null && loadedKey !== windowKey }
}
