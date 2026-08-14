import assert from 'node:assert/strict'
import test from 'node:test'
import { createGovernor } from '../src/utils/pocketbaseGovernor.js'
import { createPacedPocketBase, classifyRequest } from '../src/utils/pacedPocketBase.js'

// Unit coverage for the paced PocketBase client wrapper: successful sends
// feed governor.recordSuccess(), a 429 feeds governor.recordRateLimit() and
// still propagates the original error unchanged, `$priority` is honored and
// stripped before reaching the wrapped `send`, and classifyRequest's default
// rules match the brief.

function makeClock(start = 0) {
  let value = start
  return { now: () => value, advance(ms) { value += ms } }
}

function makeStorage() {
  const data = new Map()
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  }
}

function rateLimitError() {
  const err = new Error('Something went wrong.')
  err.status = 429
  return err
}

test('classifyRequest: health path is background', () => {
  assert.equal(classifyRequest('/api/health', { method: 'GET' }), 'background')
  assert.equal(classifyRequest('/api/health/', { method: 'GET' }), 'background')
})

test('classifyRequest: any other GET is interactive', () => {
  assert.equal(classifyRequest('/api/collections/products/records', { method: 'GET' }), 'interactive')
  assert.equal(classifyRequest('/api/collections/products/records'), 'interactive', 'missing options defaults method to GET')
})

test('classifyRequest: write verbs (including the batch endpoint) are write', () => {
  assert.equal(classifyRequest('/api/collections/products/records', { method: 'POST' }), 'write')
  assert.equal(classifyRequest('/api/collections/products/records/abc', { method: 'PATCH' }), 'write')
  assert.equal(classifyRequest('/api/collections/products/records/abc', { method: 'PUT' }), 'write')
  assert.equal(classifyRequest('/api/collections/products/records/abc', { method: 'DELETE' }), 'write')
  assert.equal(classifyRequest('/api/batch', { method: 'POST' }), 'write')
})

test('classifyRequest: unclassified methods fall back to interactive', () => {
  assert.equal(classifyRequest('/api/some/odd/endpoint', { method: 'OPTIONS' }), 'interactive')
  assert.equal(classifyRequest(undefined, {}), 'interactive')
})

test('createPacedPocketBase: a successful send calls governor.recordSuccess() and returns the result', async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-paced-success' })

  let recordSuccessCalls = 0
  const originalRecordSuccess = governor.recordSuccess
  governor.recordSuccess = (...args) => { recordSuccessCalls += 1; return originalRecordSuccess(...args) }

  let sendCalledWith = null
  const fakePb = {
    send(path, options) {
      sendCalledWith = { path, options }
      return Promise.resolve({ ok: true })
    },
  }

  const paced = createPacedPocketBase(fakePb, governor)
  const result = await paced.send('/api/collections/products/records', { method: 'GET' })

  assert.deepEqual(result, { ok: true })
  assert.equal(recordSuccessCalls, 1)
  assert.equal(sendCalledWith.path, '/api/collections/products/records')
})

test('createPacedPocketBase: a 429 rejection calls governor.recordRateLimit() and re-throws the original error unchanged', async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-paced-429' })

  let recordRateLimitCalls = 0
  const originalRecordRateLimit = governor.recordRateLimit
  governor.recordRateLimit = (...args) => { recordRateLimitCalls += 1; return originalRecordRateLimit(...args) }

  const originalError = rateLimitError()
  const fakePb = {
    send() { return Promise.reject(originalError) },
  }

  const paced = createPacedPocketBase(fakePb, governor)

  await assert.rejects(
    paced.send('/api/collections/products/records', { method: 'POST' }),
    (err) => err === originalError,
    'the exact same error instance must propagate, unmodified',
  )
  assert.equal(recordRateLimitCalls, 1)
  assert.equal(governor.isRateLimited(), true)
})

test('createPacedPocketBase: a non-429 error does not call governor.recordRateLimit(), but still propagates', async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-paced-non-429' })

  let recordRateLimitCalls = 0
  const originalRecordRateLimit = governor.recordRateLimit
  governor.recordRateLimit = (...args) => { recordRateLimitCalls += 1; return originalRecordRateLimit(...args) }

  const originalError = new Error('Failed to update record.')
  originalError.status = 400
  const fakePb = { send() { return Promise.reject(originalError) } }

  const paced = createPacedPocketBase(fakePb, governor)
  await assert.rejects(paced.send('/api/collections/products/records', { method: 'PATCH' }), (err) => err === originalError)
  assert.equal(recordRateLimitCalls, 0)
})

test('createPacedPocketBase: $priority overrides the default classification and is stripped before reaching the wrapped send', async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-paced-priority-strip' })

  let sendOptions = null
  const fakePb = {
    send(path, options) {
      sendOptions = options
      return Promise.resolve('done')
    },
  }

  const paced = createPacedPocketBase(fakePb, governor)
  // GET would normally classify as 'interactive'; force 'background' via $priority.
  const result = await paced.send('/api/collections/products/records', { method: 'GET', $priority: 'background' })

  assert.equal(result, 'done')
  assert.ok(sendOptions, 'send must have been called')
  assert.equal('$priority' in sendOptions, false, '$priority must never leak into what reaches the wrapped send (PocketBase forwards unknown keys as query params)')
  assert.equal(sendOptions.method, 'GET', 'other options must pass through untouched')
})

test('createPacedPocketBase: default classification is used when $priority is absent', async () => {
  const clock = makeClock()
  const governor = createGovernor({ now: clock.now, storage: makeStorage(), key: 'test-paced-default-classification' })

  const scheduledPriorities = []
  const originalSchedule = governor.schedule
  governor.schedule = (task, opts) => { scheduledPriorities.push(opts.priority); return originalSchedule(task, opts) }

  const fakePb = { send: () => Promise.resolve('ok') }
  const paced = createPacedPocketBase(fakePb, governor)

  await paced.send('/api/health', { method: 'GET' })
  await paced.send('/api/collections/products/records', { method: 'GET' })
  await paced.send('/api/collections/products/records', { method: 'POST' })

  assert.deepEqual(scheduledPriorities, ['background', 'interactive', 'write'])
})
