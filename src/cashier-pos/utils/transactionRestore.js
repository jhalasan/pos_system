function isOpenTransaction(transaction) {
  return transaction?.status !== 'completed'
    && transaction?.status !== 'voided'
    && transaction?.completedSale?.status !== 'voided'
}

export function restoreCashierTransactions(saved, createTransaction) {
  const restored = Array.isArray(saved?.transactions)
    ? saved.transactions.filter((transaction) => transaction && transaction.id != null)
    : []

  const highestNumericId = restored.reduce((highest, transaction) => {
    const id = Number(transaction.id)
    return Number.isFinite(id) ? Math.max(highest, id) : highest
  }, 0)
  const nextId = Math.max(1, highestNumericId + 1)
  const requestedActive = restored.find((transaction) => (
    String(transaction.id) === String(saved?.activeTransaction)
  ))
  const activeOpen = requestedActive && isOpenTransaction(requestedActive)
    ? requestedActive
    : restored.find(isOpenTransaction)

  if (activeOpen) {
    return {
      transactions: restored,
      activeTransaction: activeOpen.id,
      nextTransactionId: nextId,
    }
  }

  const freshTransaction = createTransaction(nextId)
  return {
    transactions: [...restored, freshTransaction],
    activeTransaction: freshTransaction.id,
    nextTransactionId: nextId + 1,
  }
}
