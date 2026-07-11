const isCompletedSale = (sale = {}) => {
  const rawStatus = String(sale?.rawStatus || sale?.status || '').trim().toLowerCase();
  if (rawStatus === 'voided' || rawStatus === 'adjusted') return false;
  if (rawStatus === 'completed' || sale?.status === 'Completed' || sale?.status === 'completed') return true;
  return Boolean(sale?.transactionNo || sale?.saleId || sale?.id) && (
    sale?.paymentMethod === 'cash'
    || sale?.paymentMethod === 'split'
    || sale?.paymentMethod === 'gcash'
    || sale?.totalAmount != null
    || sale?.cashAmount != null
    || sale?.gcashAmount != null
  );
};

export const normalizeCompletedSale = (sale = {}) => {
  if (!sale) return null;
  const normalized = { ...sale };
  if (isCompletedSale(normalized)) {
    normalized.status = 'completed';
    normalized.rawStatus = 'completed';
    return normalized;
  }
  return null;
};

export const getCashSalesAmount = (sales = []) => (sales || []).reduce((sum, sale) => {
  const normalized = normalizeCompletedSale(sale);
  if (!normalized) return sum;
  if (normalized.paymentMethod === 'cash') return sum + (Number(normalized.totalAmount) || 0);
  if (normalized.paymentMethod === 'split') return sum + (Number(normalized.splitPayments?.cash ?? normalized.cashAmount) || 0);
  return sum;
}, 0);

export const getCashSalesAmountFromSources = ({ retainedSales = [], currentSales = [], historySales = [], cashierId = '' } = {}) => {
  const seen = new Set();
  const deduped = [...retainedSales, ...currentSales, ...historySales].filter((sale) => {
    const normalized = normalizeCompletedSale(sale);
    if (!normalized) return false;
    if (cashierId) {
      const saleCashierId = String(normalized.cashierId || normalized.cashier_id || '').trim();
      if (saleCashierId && String(saleCashierId) !== String(cashierId)) return false;
    }
    const key = String(normalized.saleId || normalized.transactionNo || normalized.id || JSON.stringify(normalized));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return getCashSalesAmount(deduped);
};
