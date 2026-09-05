import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPrivateNetworkHost } from '../src/utils/privateNetworkHost.js'

test('isPrivateNetworkHost recognizes 192.168.0.0/16', () => {
  assert.equal(isPrivateNetworkHost('192.168.0.114'), true)
  assert.equal(isPrivateNetworkHost('192.168.255.255'), true)
})

test('isPrivateNetworkHost recognizes 10.0.0.0/8', () => {
  assert.equal(isPrivateNetworkHost('10.0.0.1'), true)
  assert.equal(isPrivateNetworkHost('10.255.255.255'), true)
})

test('isPrivateNetworkHost recognizes 172.16.0.0/12', () => {
  assert.equal(isPrivateNetworkHost('172.16.0.1'), true)
  assert.equal(isPrivateNetworkHost('172.31.255.255'), true)
  // Just outside the 172.16-31 range must NOT match -- 172.15/172.32 are
  // regular public addresses, not private ones.
  assert.equal(isPrivateNetworkHost('172.15.0.1'), false)
  assert.equal(isPrivateNetworkHost('172.32.0.1'), false)
})

test('isPrivateNetworkHost recognizes localhost and loopback', () => {
  assert.equal(isPrivateNetworkHost('localhost'), true)
  assert.equal(isPrivateNetworkHost('127.0.0.1'), true)
  assert.equal(isPrivateNetworkHost('::1'), true)
})

test('isPrivateNetworkHost rejects PocketHost and other public hosts', () => {
  assert.equal(isPrivateNetworkHost('nexasystems.pockethost.io'), false)
  assert.equal(isPrivateNetworkHost('arjovserver.tailf16d58.ts.net'), false)
  assert.equal(isPrivateNetworkHost('8.8.8.8'), false)
})

test('isPrivateNetworkHost handles missing/empty input without throwing', () => {
  assert.equal(isPrivateNetworkHost(''), false)
  assert.equal(isPrivateNetworkHost(undefined), false)
  assert.equal(isPrivateNetworkHost(null), false)
})
