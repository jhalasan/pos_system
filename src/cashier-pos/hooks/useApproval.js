import { useState } from 'react'
import { cashierApi } from '../services/api'

/**
 * Reusable approval hook for manager/admin authorization
 * Consolidates barcode and email/password approval logic
 */
export function useApproval(initialMethod = 'barcode') {
  const [method, setMethod] = useState(initialMethod)
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const reset = () => {
    setMethod(initialMethod)
    setCode('')
    setEmail('')
    setPassword('')
    setError('')
    setLoading(false)
  }

  const getPayload = () => {
    if (method === 'barcode') {
      return { code: String(code || '').trim() }
    }
    return { email: String(email || '').trim(), password }
  }

  const validate = () => {
    const payload = getPayload()
    if (!payload.code && (!payload.email || !payload.password)) {
      setError(method === 'barcode'
        ? 'Scan or enter the manager barcode.'
        : 'Enter the manager email and password.'
      )
      return false
    }
    return true
  }

  const verify = async () => {
    setError('')
    if (!validate()) return null

    setLoading(true)
    try {
      const payload = getPayload()
      const result = await cashierApi.authorizeVoid(payload)
      return result
    } catch (err) {
      setError((typeof err === 'string' ? err : err.message) || 'Invalid approval credentials.')
      return null
    } finally {
      setLoading(false)
    }
  }

  return {
    // State
    method,
    code,
    email,
    password,
    error,
    loading,
    // Actions
    setMethod,
    setCode,
    setEmail,
    setPassword,
    setError,
    reset,
    verify,
    getPayload,
    validate,
  }
}
