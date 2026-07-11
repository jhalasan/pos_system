export function getPostChangeFlowStep({ method = 'cash', splitCash = 0, drawerOpenSucceeded = false } = {}) {
  const isCashSale = method === 'cash' && Number(splitCash || 0) <= 0
  if (isCashSale) {
    return drawerOpenSucceeded ? 'register' : 'receipt'
  }

  return 'receipt'
}
