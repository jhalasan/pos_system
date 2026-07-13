function transactionTime(record) {
  const time = new Date(record?.createdAt || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

export function sortTransactionRecords(records = [], order = 'newest') {
  const direction = order === 'oldest' ? 1 : -1
  return [...records].sort((left, right) => {
    const timeDifference = transactionTime(left) - transactionTime(right)
    if (timeDifference !== 0) return timeDifference * direction
    return String(left.transactionNo || left.receiptNo || left.id || '')
      .localeCompare(String(right.transactionNo || right.receiptNo || right.id || '')) * direction
  })
}
