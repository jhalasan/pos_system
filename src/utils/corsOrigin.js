// S8: isSameRequestOrigin used to trust the client-supplied X-Forwarded-Host
// header to decide whether a request's Origin is "the same host it arrived
// at" -- but that header is just another request header, not something only
// a trusted reverse proxy can set. Any direct caller could send a forged
// X-Forwarded-Host matching the Origin it wants waved through, bypassing the
// CORS allowlist entirely. The actual `Host` header Express exposes via
// req.get('host') reflects what the client's TLS/HTTP connection was really
// addressed to and cannot be forged the same way, so it's the only host
// value this same-origin check should trust.
export function isSameHost(requestHost, originHost) {
  return Boolean(requestHost && originHost && String(requestHost).toLowerCase() === String(originHost).toLowerCase())
}
