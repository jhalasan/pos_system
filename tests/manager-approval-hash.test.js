import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveApprovalHash,
  findApprovalHashMatch,
  matchesApprovalHash,
  randomSaltHex,
} from '../src/utils/managerApprovalHash.js'

// Offline manager approval fallback (reversing S1's original online-only
// decision, per client request). The real barcode is never cached -- only
// a salted one-way hash of it. These tests verify the hash-matching
// primitives that both the server (generating hashes to hand out) and the
// client (verifying a scanned value against cached hashes while offline)
// share, so a client/server algorithm mismatch would show up here.

test('randomSaltHex produces a 32-hex-char (16-byte) value, different each call', () => {
  const a = randomSaltHex()
  const b = randomSaltHex()
  assert.equal(a.length, 32)
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)
})

test('deriveApprovalHash is deterministic for the same value and salt', async () => {
  const salt = randomSaltHex()
  const first = await deriveApprovalHash('90123456789012', salt)
  const second = await deriveApprovalHash('90123456789012', salt)
  assert.equal(first, second)
  assert.equal(first.length, 64) // 256 bits as hex
})

test('deriveApprovalHash differs for a different value with the same salt', async () => {
  const salt = randomSaltHex()
  const a = await deriveApprovalHash('90111111111111', salt)
  const b = await deriveApprovalHash('90222222222222', salt)
  assert.notEqual(a, b)
})

test('deriveApprovalHash differs for the same value with a different salt', async () => {
  const value = '90123456789012'
  const a = await deriveApprovalHash(value, randomSaltHex())
  const b = await deriveApprovalHash(value, randomSaltHex())
  assert.notEqual(a, b)
})

test('matchesApprovalHash confirms the correct value against its own hash', async () => {
  const salt = randomSaltHex()
  const hash = await deriveApprovalHash('90123456789012', salt)
  assert.equal(await matchesApprovalHash('90123456789012', salt, hash), true)
})

test('matchesApprovalHash rejects a wrong value', async () => {
  const salt = randomSaltHex()
  const hash = await deriveApprovalHash('90123456789012', salt)
  assert.equal(await matchesApprovalHash('90999999999999', salt, hash), false)
})

test('matchesApprovalHash rejects when any input is missing', async () => {
  assert.equal(await matchesApprovalHash('', 'salt', 'hash'), false)
  assert.equal(await matchesApprovalHash('code', '', 'hash'), false)
  assert.equal(await matchesApprovalHash('code', 'salt', ''), false)
})

test('findApprovalHashMatch returns the matching entry among several cached managers', async () => {
  const managerA = { approverId: 'a', approverName: 'Manager A', salt: randomSaltHex() }
  managerA.hash = await deriveApprovalHash('90111111111111', managerA.salt)
  const managerB = { approverId: 'b', approverName: 'Manager B', salt: randomSaltHex() }
  managerB.hash = await deriveApprovalHash('90222222222222', managerB.salt)

  const match = await findApprovalHashMatch('90222222222222', [managerA, managerB])
  assert.equal(match?.approverId, 'b')
})

test('findApprovalHashMatch returns null when nothing matches', async () => {
  const managerA = { approverId: 'a', salt: randomSaltHex() }
  managerA.hash = await deriveApprovalHash('90111111111111', managerA.salt)

  const match = await findApprovalHashMatch('90999999999999', [managerA])
  assert.equal(match, null)
})

test('findApprovalHashMatch handles an empty or malformed entry list', async () => {
  assert.equal(await findApprovalHashMatch('90111111111111', []), null)
  assert.equal(await findApprovalHashMatch('90111111111111', null), null)
  assert.equal(await findApprovalHashMatch('90111111111111', [null, undefined, {}]), null)
})
