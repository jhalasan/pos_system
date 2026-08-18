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
    if (cashierId) {
      const existing = (() => {
        try {
          const parsed = JSON.parse(store.getItem(RETAINED_COMPLETED_SALES_KEY) || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const otherCashiers = existing.filter((sale) => String(sale?.cashierId || sale?.cashier_id || '') !== String(cashierId));
      store.setItem(RETAINED_COMPLETED_SALES_KEY, JSON.stringify([...scoped, ...otherCashiers]));
    } else {
      store.setItem(RETAINED_COMPLETED_SALES_KEY, JSON.stringify(scoped));
    }
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
  if (rawStatus === 'voided') return false;
  if (rawStatus === 'completed' || rawStatus === 'adjusted' || sale?.status === 'Completed' || sale?.status === 'completed') return true;
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
    const rawStatus = String(sale?.rawStatus || sale?.status || '').trim().toLowerCase();
    normalized.status = rawStatus === 'adjusted' ? 'adjusted' : 'completed';
    normalized.rawStatus = normalized.status;
    return normalized;
  }
  return null;
};

// A refund pays cash back out of the drawer, so it reduces the sale's cash
// contribution. An exchange just swaps goods (no cash changes hands) and any
// price difference is rung up as its own separate transaction, so it does not
// reduce cash here.
const refundedCashAmount = (sale) => (Array.isArray(sale?.adjustments) ? sale.adjustments : [])
  .filter((adjustment) => adjustment?.type === 'refund')
  .reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0);

export const getCashSalesAmount = (sales = []) => (sales || []).reduce((sum, sale) => {
  const normalized = normalizeCompletedSale(sale);
  if (!normalized) return sum;
  let cashAmount = 0;
  if (normalized.paymentMethod === 'cash') cashAmount = Number(normalized.totalAmount) || 0;
  else if (normalized.paymentMethod === 'split') cashAmount = Number(normalized.splitPayments?.cash ?? normalized.cashAmount) || 0;
  const netCashAmount = Math.max(0, cashAmount - refundedCashAmount(normalized));
  return sum + netCashAmount;
}, 0);

// GCash never touches the physical drawer, so this is informational only
// (shown on the Z-read for transparency on how much a shift took in via
// GCash) -- it must never feed into the cash-count reconciliation math
// (Expected Cash / Counted Cash / Variance) the way getCashSalesAmount does.
// A refund is assumed paid back out of the drawer regardless of the
// original payment method (see refundedCashAmount's own comment, and the
// fact that a gcash sale's cashAmount already starts at 0 above and is
// unaffected by a refund) -- so this deliberately does not subtract
// refunds the way the cash total does; there is no separate "refunded via
// GCash" figure tracked anywhere in this system to subtract.
export const getGcashSalesAmount = (sales = []) => (sales || []).reduce((sum, sale) => {
  const normalized = normalizeCompletedSale(sale);
  if (!normalized) return sum;
  let gcashAmount = 0;
  if (normalized.paymentMethod === 'gcash') gcashAmount = Number(normalized.totalAmount) || 0;
  else if (normalized.paymentMethod === 'split') gcashAmount = Number(normalized.splitPayments?.gcash ?? normalized.gcashAmount) || 0;
  return sum + Math.max(0, gcashAmount);
}, 0);

const dedupedCompletedSales = ({ retainedSales = [], currentSales = [], historySales = [], cashierId = '' } = {}) => {
  const seen = new Set();
  return [...retainedSales, ...currentSales, ...historySales].filter((sale) => {
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
};

export const getCashSalesAmountFromSources = (sources) => getCashSalesAmount(dedupedCompletedSales(sources));

export const getGcashSalesAmountFromSources = (sources) => getGcashSalesAmount(dedupedCompletedSales(sources));
