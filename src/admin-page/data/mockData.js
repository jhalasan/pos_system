/* ------------------------------------------------------------
   Mock data for the NEXA POS admin dashboard (frontend only).
   Replace these with real API calls when the backend is ready.
   ------------------------------------------------------------ */

export const dashboardStats = {
  dailySales: 18420,
  dailySalesTrend: +12.4,
  monthlySales: 312750,
  monthlySalesTrend: +6.8,
  totalRevenue: 1284900,
  totalRevenueTrend: +9.1,
  criticalStock: 5,
}

export const criticalAlerts = [
  { name: 'Coffee 3-in-1', left: 3 },
  { name: 'Bottled Water 500ml', left: 6 },
  { name: 'Instant Noodles', left: 4 },
  { name: 'Sugar 1kg', left: 2 },
  { name: 'Cooking Oil 1L', left: 5 },
]

export const productInOut = [
  { label: 'Stock In', value: 1340, color: '#4f46e5' },
  { label: 'Stock Out', value: 980, color: '#16a34a' },
  { label: 'Adjustments', value: 210, color: '#f59e0b' },
]

export const topProducts = [
  { name: 'Cigarettes', category: 'Tobacco', units: 842 },
  { name: 'Rice 5kg', category: 'Grocery', units: 631 },
  { name: 'Coffee 3-in-1', category: 'Beverages', units: 574 },
  { name: 'Bottled Water 500ml', category: 'Beverages', units: 489 },
  { name: 'Bread Loaf', category: 'Bakery', units: 402 },
]

export const hourlySales = [
  { label: '8AM', value: 620 }, { label: '9AM', value: 940 },
  { label: '10AM', value: 1180 }, { label: '11AM', value: 1320 },
  { label: '12PM', value: 1760 }, { label: '1PM', value: 1540 },
  { label: '2PM', value: 1290 }, { label: '3PM', value: 1410 },
  { label: '4PM', value: 1680 }, { label: '5PM', value: 1980 },
  { label: '6PM', value: 2240 }, { label: '7PM', value: 1870 },
]

export const monthlySales = [
  { label: 'Jan', value: 248 }, { label: 'Feb', value: 263 },
  { label: 'Mar', value: 291 }, { label: 'Apr', value: 277 },
  { label: 'May', value: 312 }, { label: 'Jun', value: 334 },
  { label: 'Jul', value: 305 }, { label: 'Aug', value: 358 },
]

export const categories = [
  'Beverages', 'Grocery', 'Bakery', 'Tobacco', 'Snacks', 'Household', 'Personal Care',
]

export const products = [
  { id: 'PRD-1001', name: 'Coffee 3-in-1', barcode: '4800101234567', category: 'Beverages', qty: 3, unit: 'Sachet', status: 'critical', price: 12 },
  { id: 'PRD-1002', name: 'Rice 5kg', barcode: '4800102234511', category: 'Grocery', qty: 86, unit: 'Sack', status: 'in-stock', price: 285 },
  { id: 'PRD-1003', name: 'Bottled Water 500ml', barcode: '4800103234599', category: 'Beverages', qty: 6, unit: 'Bottle', status: 'low', price: 15 },
  { id: 'PRD-1004', name: 'Bread Loaf', barcode: '4800104234533', category: 'Bakery', qty: 42, unit: 'Pack', status: 'in-stock', price: 55 },
  { id: 'PRD-1005', name: 'Cigarettes', barcode: '4800105234588', category: 'Tobacco', qty: 120, unit: 'Pack', status: 'in-stock', price: 145 },
  { id: 'PRD-1006', name: 'Instant Noodles', barcode: '4800106234522', category: 'Snacks', qty: 4, unit: 'Piece', status: 'critical', price: 18 },
  { id: 'PRD-1007', name: 'Sugar 1kg', barcode: '4800107234577', category: 'Grocery', qty: 2, unit: 'Pack', status: 'critical', price: 78 },
  { id: 'PRD-1008', name: 'Cooking Oil 1L', barcode: '4800108234566', category: 'Grocery', qty: 5, unit: 'Bottle', status: 'low', price: 165 },
  { id: 'PRD-1009', name: 'Dish Soap', barcode: '4800109234544', category: 'Household', qty: 58, unit: 'Bottle', status: 'in-stock', price: 64 },
  { id: 'PRD-1010', name: 'Shampoo Sachet', barcode: '4800110234500', category: 'Personal Care', qty: 210, unit: 'Sachet', status: 'in-stock', price: 8 },
]

export const cashiers = [
  { id: 'CSH-01', name: 'Maria Santos', email: 'maria.santos@nexapos.com', shift: 'Morning', status: 'active', sales: 42180 },
  { id: 'CSH-02', name: 'John Cruz', email: 'john.cruz@nexapos.com', shift: 'Afternoon', status: 'active', sales: 38640 },
  { id: 'CSH-03', name: 'Ana Reyes', email: 'ana.reyes@nexapos.com', shift: 'Evening', status: 'inactive', sales: 29510 },
]

export const activityLogs = [
  { id: 1, user: 'Admin', userType: 'Admin', action: 'Login', detail: 'Signed in to admin dashboard', time: '2026-05-21 08:02' },
  { id: 2, user: 'Maria Santos', userType: 'Cashier', action: 'Sale', detail: 'Completed transaction TXN-9921 — ₱1,240', time: '2026-05-21 08:15' },
  { id: 3, user: 'Admin', userType: 'Admin', action: 'Product', detail: 'Added new product "Dish Soap"', time: '2026-05-21 08:34' },
  { id: 4, user: 'John Cruz', userType: 'Cashier', action: 'Sale', detail: 'Completed transaction TXN-9922 — ₱560', time: '2026-05-21 09:01' },
  { id: 5, user: 'Admin', userType: 'Admin', action: 'Inventory', detail: 'Scanned 24 items into stock', time: '2026-05-21 09:20' },
  { id: 6, user: 'Admin', userType: 'Admin', action: 'Product', detail: 'Edited price of "Rice 5kg"', time: '2026-05-21 10:05' },
  { id: 7, user: 'Ana Reyes', userType: 'Cashier', action: 'Login', detail: 'Signed in to cashier terminal', time: '2026-05-21 10:30' },
  { id: 8, user: 'Admin', userType: 'Admin', action: 'Sync', detail: 'Synced local data to cloud', time: '2026-05-21 11:00' },
  { id: 9, user: 'Maria Santos', userType: 'Cashier', action: 'Transaction Void', detail: 'Voided transaction TXN-9923', time: '2026-05-21 11:48' },
  { id: 10, user: 'John Cruz', userType: 'Cashier', action: 'Discount', detail: 'Applied 10% discount for TXN-9924', time: '2026-05-21 12:12' },
  { id: 11, user: 'Admin', userType: 'Admin', action: 'Logout', detail: 'Admin signed out of dashboard', time: '2026-05-21 12:30' },
  { id: 12, user: 'Admin', userType: 'Admin', action: 'Stock Update', detail: 'Updated quantity for "Cooking Oil 1L"', time: '2026-05-21 12:45' },
  { id: 13, user: 'Admin', userType: 'Admin', action: 'Password Reset', detail: 'Reset password for cashier account', time: '2026-05-21 13:05' },
  { id: 14, user: 'Admin', userType: 'Admin', action: 'Cloud Sync', detail: 'Cloud backup completed successfully', time: '2026-05-21 13:30' },
]

export const statusLabel = {
  'in-stock': { text: 'In Stock', badge: 'badge-success' },
  'low': { text: 'Low Stock', badge: 'badge-warning' },
  'critical': { text: 'Critical', badge: 'badge-danger' },
}

export const peso = (n) => '₱' + Number(n).toLocaleString('en-PH')
