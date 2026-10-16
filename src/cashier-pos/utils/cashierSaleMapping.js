// Pure mappers from a local or cloud sale record to the shape the cashier
// screens use. Kept apart from desktopApi.js (which reads import.meta.env at
// import time and so cannot be loaded in a test) so the mapping -- notably
// customerName, which a reprint needs -- can be tested for real.

function saleItemCount(sale) {
  return (sale.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
}

function saleAdjustmentAmount(sale) {
  return (sale.adjustments || []).reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0)
}

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value
}

export function toCashierSale(sale, pendingIds = new Set()) {
  const adjusted = Array.isArray(sale.adjustments) && sale.adjustments.length > 0
  let paymentMethod = sale.paymentMethod
  let refNumber = sale.refNumber || ''
  let splitPayments = sale.splitPayments

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }

  return {
    id: sale.clientSaleId,
    saleId: sale.clientSaleId,
    transactionNo: sale.transactionNo,
    totalAmount: sale.totalAmount,
    subtotalAmount: sale.subtotalAmount,
    discountPercent: Number(sale.discountPercent) || 0,
    discountAmount: Number(sale.discountAmount) || 0,
    paymentMethod,
    cashAmount: sale.cashAmount,
    gcashAmount: sale.gcashAmount,
    change: sale.change,
    splitPayments,
    refNumber,
    status: sale.status === 'voided'
      ? 'Voided'
      : (adjusted ? 'Adjusted' : (pendingIds.has(sale.clientSaleId) || sale.syncStatus === 'pending' ? 'Pending sync' : 'Completed')),
    rawStatus: sale.status || 'completed',
    syncStatus: sale.syncStatus || (pendingIds.has(sale.clientSaleId) ? 'pending' : ''),
    createdAt: sale.createdAt,
    itemCount: saleItemCount(sale),
    items: sale.items || [],
    cashierId: sale.cashierId || '',
    cashierName: sale.cashierName || '',
    customerName: sale.customerName || '',
    approvedBy: sale.voidedBy || '',
    voidedAt: sale.voidedAt || '',
    voidReason: sale.voidReason || '',
    adjustments: sale.adjustments || [],
    adjustedAt: sale.adjustedAt || '',
    adjustedAmount: saleAdjustmentAmount(sale),
  }
}

function cloudCashierName(sale) {
  const cashier = Array.isArray(sale.expand?.cashier_id)
    ? sale.expand.cashier_id[0]
    : sale.expand?.cashier_id
  return cashier?.name || cashier?.email || firstRelation(sale.cashier_id) || ''
}

export function cloudSaleItemToLocal(item) {
  const product = Array.isArray(item.expand?.product_id)
    ? item.expand.product_id[0]
    : item.expand?.product_id

  return {
    productId: firstRelation(item.product_id) || '',
    name: product?.name || item.name || firstRelation(item.product_id) || 'Item',
    barcode: product?.barcode || item.barcode || '',
    quantity: Number(item.quantity_sold ?? item.quantity) || 0,
    price: Number(item.price_at_sale ?? item.price) || 0,
  }
}

export function toCashierCloudSale(sale, items = []) {
  let paymentMethod = sale.payment_method || sale.paymentMethod || 'cash'
  let refNumber = sale.ref_number || sale.refNumber || ''
  let splitPayments = { cash: '', gcash: '', gcashRef: '' }

  if (String(refNumber).startsWith('split:')) {
    try {
      splitPayments = JSON.parse(String(refNumber).slice(6))
      paymentMethod = 'split'
      refNumber = ''
    } catch {
      paymentMethod = 'split'
    }
  }

  return toCashierSale({
    clientSaleId: sale.id,
    transactionNo: sale.transaction_no || sale.transactionNo || sale.id,
    totalAmount: Number(sale.total_amount ?? sale.totalAmount) || 0,
    subtotalAmount: Number(sale.subtotal_amount ?? sale.subtotalAmount ?? sale.total_amount) || 0,
    discountPercent: Number(sale.discount_percent ?? sale.discountPercent) || 0,
    discountAmount: Number(sale.discount_amount ?? sale.discountAmount) || 0,
    paymentMethod,
    cashAmount: paymentMethod === 'cash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : '',
    gcashAmount: paymentMethod === 'gcash' ? Number(sale.total_amount ?? sale.totalAmount) || 0 : '',
    change: 0,
    refNumber,
    splitPayments,
    status: sale.status || 'completed',
    syncStatus: 'synced',
    createdAt: sale.created_at || sale.createdAt || sale.created,
    cashierId: firstRelation(sale.cashier_id) || '',
    cashierName: cloudCashierName(sale),
    customerName: sale.customer_name || sale.customerName || '',
    items,
    adjustments: [],
  })
}
