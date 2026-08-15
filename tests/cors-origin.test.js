import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSameHost } from '../src/utils/corsOrigin.js'

// S8: isSameRequestOrigin used to trust the client-supplied X-Forwarded-Host
// header as proof a request's Origin matched the host it arrived at, which
// let any direct caller forge that header to bypass the CORS allowlist.

test('matches identical hosts', () => {
  assert.equal(isSameHost('example.com', 'example.com'), true)
})

test('matches case-insensitively', () => {
  assert.equal(isSameHost('Example.com', 'example.COM'), true)
})

test('rejects different hosts', () => {
  assert.equal(isSameHost('example.com', 'attacker.example'), false)
})

test('rejects when either host is missing', () => {
  assert.equal(isSameHost('', 'example.com'), false)
  assert.equal(isSameHost('example.com', ''), false)
  assert.equal(isSameHost(undefined, undefined), false)
})
