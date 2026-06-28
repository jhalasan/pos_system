const DEFAULT_RETRY_MS = 5 * 60 * 1000

let rateLimitedUntil = 0

function textFromError(error) {
  return [
    error?.response?.message,
    error?.data?.message,
    error?.message,
    String(error || ''),
  ].filter(Boolean).join(' ')
}

function retryMsFromError(error) {
  const retryAfter = Number(error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000

  const text = textFromError(error)
  const seconds = Number(text.match(/retry after\s+(\d+)\s+seconds/i)?.[1])
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000

  return DEFAULT_RETRY_MS
}

export function isPocketBaseRateLimit(error) {
  return Number(error?.status) === 429 || /too many requests|rate.?limit|retry after/i.test(textFromError(error))
}

export function rememberPocketBaseRateLimit(error) {
  if (!isPocketBaseRateLimit(error)) return false
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryMsFromError(error))
  return true
}

export function pocketBaseRateLimitRemainingMs() {
  return Math.max(0, rateLimitedUntil - Date.now())
}

export function isPocketBaseRateLimited() {
  return pocketBaseRateLimitRemainingMs() > 0
}

export function pocketBaseRateLimitMessage() {
  const remainingMs = pocketBaseRateLimitRemainingMs()
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  return `PocketHost rate limit reached. Try again in about ${minutes} minute(s).`
}
