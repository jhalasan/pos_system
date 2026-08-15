// Offline-capable manager approval (reversing S1's original online-only
// decision, per client request -- relying on internet always being up is
// not acceptable for their store). A manager's actual barcode/approval code
// must never be cached on a cashier terminal in reversible form -- that is
// exactly the leak S1 closed. Instead the server computes a salted,
// one-way PBKDF2 hash of each active manager credential and hands out only
// the hash; a terminal caches the hash, and offline verification means
// hashing the scanned/typed value locally and comparing -- the real value
// never needs to be known ahead of time, and the cached hash cannot be
// reversed back into it.
//
// Uses the standard Web Crypto API (globalThis.crypto.subtle), available
// identically in Node (server), the browser, and Tauri's WebView2-based
// webview (client) -- the same code runs on both sides, so there is no risk
// of a client/server algorithm mismatch producing hashes that never match.

const PBKDF2_ITERATIONS = 100_000
const HASH_ALGORITHM = 'SHA-256'
const KEY_LENGTH_BITS = 256
const SALT_BYTES = 16

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const clean = String(hex || '').trim()
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function randomSaltHex() {
  const salt = new Uint8Array(SALT_BYTES)
  globalThis.crypto.getRandomValues(salt)
  return bytesToHex(salt)
}

export async function deriveApprovalHash(value, saltHex) {
  const encoder = new TextEncoder()
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(String(value ?? '')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derived = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    keyMaterial,
    KEY_LENGTH_BITS,
  )
  return bytesToHex(new Uint8Array(derived))
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

export async function matchesApprovalHash(value, saltHex, expectedHashHex) {
  if (!value || !saltHex || !expectedHashHex) return false
  const computed = await deriveApprovalHash(value, saltHex)
  return timingSafeEqualHex(computed, expectedHashHex)
}

// Checks a candidate value against every cached entry and returns the first
// match's associated data (approverId/approverName), or null. Entries are
// tried sequentially -- PBKDF2 is deliberately slow, but a cashier terminal
// only ever caches a handful of active managers, so this stays well within
// an acceptable approval-flow latency.
export async function findApprovalHashMatch(value, entries = []) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    // eslint-disable-next-line no-await-in-loop
    if (await matchesApprovalHash(value, entry?.salt, entry?.hash)) return entry
  }
  return null
}
