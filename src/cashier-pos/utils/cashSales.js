const RETAINED_COMPLETED_SALES_KEY = 'nexa_retained_completed_sales';

const storage = () => {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  return null;
};

export const saveRetainedCompletedSales = (sales = [], cashierId = '') => {
  const payload = Array.isArray(sales) ? sales : [];
  const store = storage();
  if (store) {
    const nextPayload = payload.map((sale) => {
      if (!sale) return sale;
      if (!cashierId) return sale;
      if (!sale.cashierId && !sale.cashier_id) {
        return { ...sale, cashierId };
      }
      return sale;
    });
    const scoped = cashierId
      ? nextPayload.filter((sale) => String(sale?.cashierId || sale?.cashier_id || '') === String(cashierId))
      : nextPayload;
    store.setItem(RETAINED_COMPLETED_SALES_KEY, JSON.stringify(scoped));
    return scoped;
  }
  return payload;
};

export const loadRetainedCompletedSales = (cashierId = '') => {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(RETAINED_COMPLETED_SALES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (!cashierId) return parsed;
    return parsed.filter((sale) => String(sale?.cashierId || sale?.cashier_id || '') === String(cashierId));
  } catch {
    return [];
  }
};

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
