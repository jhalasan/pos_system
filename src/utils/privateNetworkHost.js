// Detects whether a hostname is a private/local-network address (RFC 1918
// ranges, loopback, or bare "localhost") rather than a public internet host.
//
// Written for pacedPocketBase.js: its rate governor (pocketbaseGovernor.js)
// was built specifically to survive PocketHost's own 429 throttling, and
// paces every request to a maximum of a few per second regardless of which
// PocketBase instance it's actually talking to. That pacing makes no sense
// against a client's own self-hosted PocketBase on their shop's LAN, which
// has no such rate limit at all -- it was just needlessly slowing down
// every sync/scan/checkout call once a deployment switched from PocketHost
// to a local server. This lets that call site skip pacing entirely for a
// private-network target.
export function isPrivateNetworkHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}
