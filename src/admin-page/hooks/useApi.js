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
