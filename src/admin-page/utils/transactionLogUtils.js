function transactionTime(record) {
  const time = new Date(record?.createdAt || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

export function sortTransactionRecords(records = [], order = 'newest') {
  if (order === 'total-high' || order === 'total-low') {
    const direction = order === 'total-high' ? -1 : 1
    return [...records].sort((left, right) => ((Number(left.totalAmount) || 0) - (Number(right.totalAmount) || 0)) * direction)
  }
  if (order === 'customer' || order === 'cashier') {
    const field = order === 'customer' ? 'customerName' : 'cashierName'
    return [...records].sort((left, right) => String(left[field] || '').localeCompare(String(right[field] || ''), undefined, { sensitivity: 'base' }))
  }
  const direction = order === 'oldest' ? 1 : -1
  return [...records].sort((left, right) => {
    const timeDifference = transactionTime(left) - transactionTime(right)
    if (timeDifference !== 0) return timeDifference * direction
    return String(left.transactionNo || left.receiptNo || left.id || '')
      .localeCompare(String(right.transactionNo || right.receiptNo || right.id || '')) * direction
  })
}
