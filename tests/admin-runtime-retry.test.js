import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetryableRuntime } from '../src/admin-page/offline/runtime.js'

test('a rejected bootstrap attempt is not cached — the next call retries', async () => {
  let calls = 0
  const runtime = createRetryableRuntime(async () => {
    calls += 1
    if (calls === 1) throw new Error('Dexie VersionError (simulated)')
    return { ok: true }
  })

  await assert.rejects(() => runtime.start(), /VersionError/)
  assert.equal(calls, 1)

  const result = await runtime.start()
  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2, 'the second call must retry the bootstrap, not replay the cached rejection')
})

test('concurrent calls during a single in-flight bootstrap share the same attempt', async () => {
  let calls = 0
  const runtime = createRetryableRuntime(async () => {
    calls += 1
    return { ok: true }
  })

  const [a, b] = await Promise.all([runtime.start(), runtime.start()])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
})

test('reset() forces the next call to bootstrap again even after success', async () => {
  let calls = 0
  const runtime = createRetryableRuntime(async () => {
    calls += 1
    return { attempt: calls }
  })

  await runtime.start()
  runtime.reset()
  const second = await runtime.start()
  assert.equal(second.attempt, 2)
})
