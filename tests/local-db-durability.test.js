import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cashierDb, initializeCashierDb } from '../src/cashier-pos/offline/db.js'
import { adminDb } from '../src/admin-page/offline/db.js'

// Chromium's default IndexedDB durability is 'relaxed' (a write is reported
// saved before it is flushed to disk). Both local databases hold queued sales
// and stock operations, so a power cut must not be able to lose the latest ones.

test('both local databases are opened with strict (flush-to-disk) transactions', () => {
  assert.equal(cashierDb._options.chromeTransactionDurability, 'strict')
  assert.equal(adminDb._options.chromeTransactionDurability, 'strict')
})

test('transactions are actually created with the strict durability hint', async () => {
  await initializeCashierDb()
  const seen = []
  const originalTransaction = cashierDb.core.transaction.bind(cashierDb.core)
  cashierDb.core.transaction = (stores, mode, options) => {
    seen.push({ mode, durability: options?.durability })
    return originalTransaction(stores, mode, options)
  }
  try {
    await cashierDb.settings.put({ key: 'durability-probe', value: 1 })
    assert.ok(seen.some((entry) => entry.mode === 'readwrite' && entry.durability === 'strict'),
      `expected a readwrite transaction with durability "strict", saw ${JSON.stringify(seen)}`)
  } finally {
    cashierDb.core.transaction = originalTransaction
    await cashierDb.settings.delete('durability-probe')
  }
})

test('reads and writes behave exactly as before with strict durability', async () => {
  await initializeCashierDb()
  await cashierDb.transaction('rw', cashierDb.settings, async () => {
    await cashierDb.settings.put({ key: 'a', value: 1 })
    await cashierDb.settings.put({ key: 'b', value: 2 })
  })
  assert.equal((await cashierDb.settings.get('a')).value, 1)
  assert.equal((await cashierDb.settings.get('b')).value, 2)
  await cashierDb.settings.bulkDelete(['a', 'b'])
})
