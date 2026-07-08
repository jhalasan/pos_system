import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRepeat, ClockHistory, Dash, Gear, Plus, Printer, Receipt, Trash, XLg, Cart } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router-dom';
import Input from '../../components/common/Input';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import Modal from '../../components/common/Modal';
import SyncStatusIndicator from '../../components/SyncStatusIndicator';
import { cashierApi, money } from '../services/api';
import { getReceiptPrinterStatus, openCashDrawer, printCompletedReceipt, printReceiptPdf, printShiftCloseReceipt } from '../services/receiptPrinter';
import { getStoredTheme, saveTheme, THEMES } from '../../utils/themeSettings';
import { toBaseStockQuantity } from '../offline/stockUtils';
import styles from '../styles/Cashier.module.css';

function stockState(item) {
  const stockQty = Number(item.stockQty ?? item.qty) || 0;
  const lowStock = Number(item.lowStock) || 0;
  if (stockQty <= 0) return { key: 'out', label: 'Out of stock' };
  if (lowStock > 0 && stockQty <= lowStock) return { key: 'low', label: `Low stock: ${stockQty} left` };
  return { key: 'ok', label: `${stockQty} in stock` };
}

function normalizeSellingUnits(product = {}) {
  const baseUnit = String(product.unit || 'Piece').trim() || 'Piece';
  const baseBarcode = String(product.barcode || '').trim();
  const parsedUnits = Array.isArray(product.sellingUnits) ? product.sellingUnits : [];
  const units = parsedUnits.map((unit) => ({
    barcode: String(unit?.barcode || '').trim(),
    unit: String(unit?.unit || '').trim() || baseUnit,
    conversion: Number(unit?.conversion) > 0 ? Number(unit.conversion) : 1,
    price: Number(unit?.price) || 0,
  })).filter((unit) => unit.barcode || unit.unit || unit.conversion || unit.price);

  const hasBase = units.some((unit) => Number(unit.conversion) === 1);
  const normalizedUnits = hasBase
    ? units
    : [{
      barcode: baseBarcode,
      unit: baseUnit,
      conversion: 1,
      price: Number(product.price) || 0,
    }, ...units];

  return normalizedUnits
    .map((unit, index) => ({
      ...unit,
      barcode: unit.barcode || (index === 0 ? baseBarcode : ''),
      price: Number(unit.price) || Number(product.price) || 0,
    }))
    .sort((a, b) => Number(b.conversion) - Number(a.conversion));
}

function sellingUnitKey(unit = {}) {
  const barcode = String(unit.barcode || '').trim();
  if (barcode) return `barcode:${barcode}`;
  return `unit:${String(unit.unit || '').trim().toLowerCase()}:${Number(unit.conversion) || 1}`;
}

function findSellingUnit(product = {}, barcode = '') {
  const code = String(barcode || '').trim();
  const units = normalizeSellingUnits(product);
  const matchedUnit = product.matchingUnit
    ? {
      barcode: String(product.matchingUnit.barcode || '').trim(),
      unit: String(product.matchingUnit.unit || product.unit || '').trim(),
      conversion: Number(product.matchingUnit.conversion) > 0 ? Number(product.matchingUnit.conversion) : 1,
      price: Number(product.matchingUnit.price) || Number(product.price) || 0,
    }
    : null;

  if (matchedUnit?.barcode && (!code || matchedUnit.barcode === code)) return matchedUnit;
  if (code) {
    return units.find((unit) => String(unit.barcode || '').trim() === code) || units[0];
  }
  return matchedUnit || units[0];
}

function pluralUnit(unit, quantity = 2) {
  const label = String(unit || 'item').trim() || 'item';
  const irregular = { box: 'Boxes', piece: 'Pieces', tray: 'Trays' };
  if (Number(quantity) === 1 || /s$/i.test(label)) return label;
  return irregular[label.toLowerCase()] || `${label}s`;
}

function ProductThumb({ product }) {
  const imageUrl = product?.imageUrl || product?.image || '';

  return (
    <span className={styles['product-thumb']} aria-hidden="true">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : (
        <Cart size={18} />
      )}
    </span>
  );
}

function todayPrefix() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
}

function nextLocalTransactionNo(transactionNo, offset = 1) {
  const value = String(transactionNo || '');
  const prefix = value.slice(0, 8) || todayPrefix();
  const sequence = Number(value.slice(8)) || 0;
  return `${prefix}${String(sequence + offset).padStart(4, '0')}`;
}

function createTransaction(id, transactionNo = `${todayPrefix()}${String(id).padStart(4, '0')}`) {
  return {
    id,
    transactionNo,
    name: `TXN ${transactionNo}`,
    cartItems: [],
    discount: 0,
    paymentMethod: 'cash',
    isSplitPayment: false,
    splitPayments: { cash: '', gcash: '', gcashRef: '' },
    cashAmount: '',
    gcashAmount: '',
    gcashRef: '',
    lastScanned: null,
    status: 'open',
    completedSale: null,
  };
}

function formatTransactionTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTransactionDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function returnedQuantityForItem(sale, productId) {
  return (sale?.adjustments || [])
    .flatMap((adjustment) => adjustment.items || [])
    .filter((item) => String(item.productId || item.id || '') === String(productId || ''))
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

const RECEIPT_SETTINGS_KEY = 'nexa_receipt_print_settings';
const CASHIER_SHORTCUT_SETTINGS_KEY = 'nexa_cashier_shortcut_settings';
const CASHIER_CASH_COUNT_HISTORY_KEY = 'nexa_cashier_cash_count_history';
const DEFAULT_RECEIPT_SETTINGS = {
  autoPrint: false,
  showPdfTestButton: false,
  printerName: '',
  receiptBeforeFeedLines: 0,
  receiptAfterFeedLines: 0,
  receiptPdfDirectory: '',
};
const CASHIER_SHORTCUTS = [
  { action: 'focusBarcode', label: 'Focus barcode scan', defaultKeys: 'F1' },
  { action: 'requestDiscount', label: 'Request discount', defaultKeys: 'F2' },
  { action: 'focusSearch', label: 'Focus product search', defaultKeys: 'F3' },
  { action: 'focusQuantity', label: 'Focus item quantity', defaultKeys: 'F4' },
  { action: 'newTransaction', label: 'New transaction', defaultKeys: 'Ctrl+N' },
  { action: 'completeTransaction', label: 'Complete transaction / Pay', defaultKeys: 'F10' },
  { action: 'voidTransaction', label: 'Void current transaction', defaultKeys: 'Ctrl+Backspace' },
  { action: 'paymentCash', label: 'Select cash payment', defaultKeys: 'Ctrl+1' },
  { action: 'paymentGcash', label: 'Select GCash payment', defaultKeys: 'Ctrl+2' },
  { action: 'reprintReceipt', label: 'Print receipt copy', defaultKeys: 'Ctrl+P' },
  { action: 'receiptLookup', label: 'Receipt lookup', defaultKeys: 'F6' },
  { action: 'history', label: 'Transaction history', defaultKeys: 'F7' },
  { action: 'sync', label: 'Sync now', defaultKeys: 'Ctrl+S' },
  { action: 'settings', label: 'Open settings', defaultKeys: 'Ctrl+,' },
];
const DEFAULT_SHORTCUT_SETTINGS = {
  version: 3,
  showLabels: true,
  shortcuts: CASHIER_SHORTCUTS.reduce((map, item) => ({ ...map, [item.action]: item.defaultKeys }), {}),
};
const CASHIER_AUDIT_ENTRY_KEY = 'nexa_cashier_audit_entry';
const CASHIER_SHIFT_KEY = 'nexa_cashier_shift_session';
const CASHIER_DEVICE_KEY = 'nexa_cashier_device_id';
const IDLE_LOCK_MS = 5 * 60 * 1000;
const CASH_FLOW_CATEGORIES = {
  in: ['Additional drawer fund', 'Correction', 'Customer change return', 'Other'],
  out: ['Supplier payment', 'Bank deposit', 'Petty cash', 'Correction', 'Other'],
};
const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];

function loadReceiptSettings() {
  try {
    return {
      ...DEFAULT_RECEIPT_SETTINGS,
      ...JSON.parse(localStorage.getItem(RECEIPT_SETTINGS_KEY) || '{}'),
    };
  } catch {
    return DEFAULT_RECEIPT_SETTINGS;
  }
}

function loadShortcutSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CASHIER_SHORTCUT_SETTINGS_KEY) || '{}');
    if (saved.version !== DEFAULT_SHORTCUT_SETTINGS.version) {
      return {
        ...DEFAULT_SHORTCUT_SETTINGS,
        showLabels: saved.showLabels ?? DEFAULT_SHORTCUT_SETTINGS.showLabels,
      };
    }
    return {
      ...DEFAULT_SHORTCUT_SETTINGS,
      ...saved,
      shortcuts: {
        ...DEFAULT_SHORTCUT_SETTINGS.shortcuts,
        ...(saved.shortcuts || {}),
      },
    };
  } catch {
    return DEFAULT_SHORTCUT_SETTINGS;
  }
}

function loadCashierAuditEntry() {
  try {
    return {
      cashBeginning: '',
      cashEnding: '',
      cashOnHand: '',
      actualCashEnding: '',
      countMode: 'manual',
      denominations: {},
      ...JSON.parse(localStorage.getItem(CASHIER_AUDIT_ENTRY_KEY) || '{}'),
    };
  } catch {
    return { cashBeginning: '', cashEnding: '', cashOnHand: '', actualCashEnding: '', countMode: 'manual', denominations: {} };
  }
}

function shiftStorageKey(userId) {
  return `${CASHIER_SHIFT_KEY}:${userId || 'cashier'}`;
}

function loadCashierShift(userId) {
  try {
    const session = JSON.parse(localStorage.getItem(shiftStorageKey(userId)) || 'null');
    return session?.status === 'open' ? session : null;
  } catch {
    return null;
  }
}

function cashierDeviceId() {
  let deviceId = localStorage.getItem(CASHIER_DEVICE_KEY);
  if (!deviceId) {
    deviceId = `POS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    localStorage.setItem(CASHIER_DEVICE_KEY, deviceId);
  }
  return deviceId;
}

function normalizeShortcut(value) {
  return String(value || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+');
}

function shortcutFromEvent(e) {
  const keyMap = {
    ' ': 'Space',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    Escape: 'Escape',
  };
  const key = keyMap[e.key] || e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';

  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');

  const printableKey = key.length === 1 ? key.toUpperCase() : key;
  parts.push(printableKey);
  return parts.join('+');
}

function isEditableTarget(target) {
  if (!target) return false;
  const tagName = target.tagName;
  return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function receiptStepLabel() {
  return 'Receipt';
}

function nextReceiptStep() {
  return 'reprint';
}

function receiptButtonText(sale) {
  return sale?.receiptPrinted ? 'Reprint Receipt' : 'Print Receipt';
}

function loadCashCountHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CASHIER_CASH_COUNT_HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
}

const Cashier = ({ onLogout, user }) => {
  const navigate = useNavigate();
  const barcodeInputRef = useRef(null);
  const searchProductInputRef = useRef(null);
  const initialQuantityInputRef = useRef(null);
  const quantityInputRefs = useRef(new Map());
  const paymentAmountInputRef = useRef(null);
  const paymentFlowPanelRef = useRef(null);
  const splitCashInputRef = useRef(null);
  const splitGcashInputRef = useRef(null);
  const [transactions, setTransactions] = useState(() => [createTransaction(1)]);
  const [activeTransaction, setActiveTransaction] = useState(1);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [barcode, setBarcode] = useState('');
  const [searchProduct, setSearchProduct] = useState('');
  const [pendingCartProduct, setPendingCartProduct] = useState(null);
  const [pendingCartUnitKey, setPendingCartUnitKey] = useState('');
  const [initialCartQuantity, setInitialCartQuantity] = useState('1');
  const [initialCartQuantityError, setInitialCartQuantityError] = useState('');
  const [paymentFlow, setPaymentFlow] = useState({
    open: false,
    step: 'amount',
    amount: '',
    error: '',
    busy: false,
    completedTxn: null,
  });
  const [cashRegisterOpen, setCashRegisterOpen] = useState(false);
  const [notification, setNotification] = useState('');
  const [receiptPrintQueue, setReceiptPrintQueue] = useState([]);
  const [printerQueueJobs, setPrinterQueueJobs] = useState([]);
  const receiptPrintLocksRef = useRef(new Set());
  const receiptPrintJobIdRef = useRef(0);
  const [showVoidAuth, setShowVoidAuth] = useState(false);
  const [managerBarcode, setManagerBarcode] = useState('');
  const [voidError, setVoidError] = useState('');
  const [showCompletedVoidModal, setShowCompletedVoidModal] = useState(false);
  const [completedVoidTarget, setCompletedVoidTarget] = useState(null);
  const [completedVoidApprovalMethod, setCompletedVoidApprovalMethod] = useState('barcode');
  const [completedVoidCode, setCompletedVoidCode] = useState('');
  const [completedVoidEmail, setCompletedVoidEmail] = useState('');
  const [completedVoidPassword, setCompletedVoidPassword] = useState('');
  const [completedVoidReason, setCompletedVoidReason] = useState('');
  const [completedVoidError, setCompletedVoidError] = useState('');
  const [completedVoidLoading, setCompletedVoidLoading] = useState(false);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [discountApprovalMethod, setDiscountApprovalMethod] = useState('barcode');
  const [discountApprovalCode, setDiscountApprovalCode] = useState('');
  const [discountApprovalEmail, setDiscountApprovalEmail] = useState('');
  const [discountApprovalPassword, setDiscountApprovalPassword] = useState('');
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountError, setDiscountError] = useState('');
  const [discountApproved, setDiscountApproved] = useState(false);
  const [showCashFlowModal, setShowCashFlowModal] = useState(false);
  const [cashFlowType, setCashFlowType] = useState('out');
  const [cashFlowAmount, setCashFlowAmount] = useState('');
  const [cashFlowCategory, setCashFlowCategory] = useState(CASH_FLOW_CATEGORIES.out[0]);
  const [cashFlowReason, setCashFlowReason] = useState('');
  const [cashFlowApprovalMethod, setCashFlowApprovalMethod] = useState('barcode');
  const [cashFlowApprovalCode, setCashFlowApprovalCode] = useState('');
  const [cashFlowApprovalEmail, setCashFlowApprovalEmail] = useState('');
  const [cashFlowApprovalPassword, setCashFlowApprovalPassword] = useState('');
  const [cashFlowError, setCashFlowError] = useState('');
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [historyRecords, setHistoryRecords] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [nextTransactionNo, setNextTransactionNo] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showReceiptLookup, setShowReceiptLookup] = useState(false);
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupSale, setLookupSale] = useState(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupMode, setLookupMode] = useState('verify');
  const [lookupApprovalMethod, setLookupApprovalMethod] = useState('barcode');
  const [lookupApprovalCode, setLookupApprovalCode] = useState('');
  const [lookupApprovalEmail, setLookupApprovalEmail] = useState('');
  const [lookupApprovalPassword, setLookupApprovalPassword] = useState('');
  const [lookupReason, setLookupReason] = useState('');
  const [lookupNote, setLookupNote] = useState('');
  const [lookupReturnQty, setLookupReturnQty] = useState({});
  const [lookupActionLoading, setLookupActionLoading] = useState(false);
  const [showReceiptSettings, setShowReceiptSettings] = useState(false);
  const [receiptSettings, setReceiptSettings] = useState(loadReceiptSettings);
  const [shortcutSettings, setShortcutSettings] = useState(loadShortcutSettings);
  const [settingsTab, setSettingsTab] = useState('shortcuts');
  const [theme, setTheme] = useState(getStoredTheme);
  const [cashierAuditEntry, setCashierAuditEntry] = useState(loadCashierAuditEntry);
  const [cashCountHistory, setCashCountHistory] = useState(loadCashCountHistory);
  const [cashierAuditSaving, setCashierAuditSaving] = useState(false);
  const [cashierAuditMessage, setCashierAuditMessage] = useState('');
  const [shiftSession, setShiftSession] = useState(() => loadCashierShift(user?.id));
  const [showShiftOpen, setShowShiftOpen] = useState(false);
  const [showShiftClose, setShowShiftClose] = useState(false);
  const [shiftOpeningAmount, setShiftOpeningAmount] = useState('');
  const [shiftClosingAmount, setShiftClosingAmount] = useState('');
  const [shiftCloseCountMode, setShiftCloseCountMode] = useState('denomination');
  const [shiftCloseDenominations, setShiftCloseDenominations] = useState({});
  const [shiftNote, setShiftNote] = useState('');
  const [shiftError, setShiftError] = useState('');
  const [shiftSaving, setShiftSaving] = useState(false);
  const [showAdminLogout, setShowAdminLogout] = useState(false);
  const [adminLogoutApprovalMethod, setAdminLogoutApprovalMethod] = useState('barcode');
  const [adminLogoutApprovalCode, setAdminLogoutApprovalCode] = useState('');
  const [adminLogoutApprovalEmail, setAdminLogoutApprovalEmail] = useState('');
  const [adminLogoutApprovalPassword, setAdminLogoutApprovalPassword] = useState('');
  const [adminLogoutError, setAdminLogoutError] = useState('');
  const [adminLogoutApproved, setAdminLogoutApproved] = useState(false);
  const [adminLogoutBusy, setAdminLogoutBusy] = useState(false);
  const [deviceId] = useState(cashierDeviceId);
  const [idleLocked, setIdleLocked] = useState(false);
  const [idleUnlockMode, setIdleUnlockMode] = useState('barcode');
  const [idleUnlockBarcode, setIdleUnlockBarcode] = useState('');
  const [idleUnlockPassword, setIdleUnlockPassword] = useState('');
  const [idleUnlockError, setIdleUnlockError] = useState('');
  const [idleUnlocking, setIdleUnlocking] = useState(false);
  const activeTxn = useMemo(
    () => transactions.find((txn) => txn.id === activeTransaction) || transactions[0] || createTransaction(1),
    [transactions, activeTransaction]
  );
  const cartItems = activeTxn.cartItems;
  const discount = activeTxn.discount;
  const paymentMethod = activeTxn.paymentMethod;
  const isSplitPayment = activeTxn.isSplitPayment;
  const splitPayments = activeTxn.splitPayments;
  const cashAmount = activeTxn.cashAmount;
  const gcashAmount = activeTxn.gcashAmount;
  const gcashRef = activeTxn.gcashRef;
  const lastScanned = activeTxn.lastScanned;
  const isCompletedTxn = activeTxn.status === 'completed';
  const isVoidedTxn = activeTxn.status === 'voided' || activeTxn.completedSale?.status === 'voided';
  const isLockedTxn = isCompletedTxn || isVoidedTxn;

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;
  const cashTendered = parseFloat(cashAmount) || 0;
  const change = paymentMethod === 'cash' ? cashTendered - total : 0;
  const completedPaymentSnapshot = isCompletedTxn ? activeTxn.completedSale : null;
  const displayIsSplitPayment = completedPaymentSnapshot
    ? completedPaymentSnapshot.paymentMethod === 'split'
    : isSplitPayment;
  const displayPaymentMethod = completedPaymentSnapshot?.paymentMethod === 'split'
    ? 'cash'
    : (completedPaymentSnapshot?.paymentMethod || paymentMethod);
  const displaySubtotal = Number(completedPaymentSnapshot?.subtotalAmount ?? subtotal) || 0;
  const displayDiscountPercent = Number(completedPaymentSnapshot?.discountPercent ?? discount) || 0;
  const displayDiscountAmount = Number(completedPaymentSnapshot?.discountAmount ?? discountAmount) || 0;
  const displayTotal = Number(completedPaymentSnapshot?.totalAmount ?? total) || 0;
  const displayCashAmount = String(completedPaymentSnapshot?.cashAmount ?? cashAmount ?? '');
  const displayGcashAmount = String(completedPaymentSnapshot?.gcashAmount ?? gcashAmount ?? '');
  const displayGcashRef = String(completedPaymentSnapshot?.gcashRef ?? gcashRef ?? '');
  const displaySplitPayments = completedPaymentSnapshot?.splitPayments || splitPayments;
  const displayCashTendered = Number(displayCashAmount) || 0;
  const displayChange = Number(completedPaymentSnapshot?.change ?? change) || 0;
  const displaySplitPaid = (Number(displaySplitPayments.cash) || 0) + (Number(displaySplitPayments.gcash) || 0);
  const displaySplitRemaining = Math.max(0, displayTotal - displaySplitPaid);
  const paymentFlowCashPaid = Number(paymentFlow.completedTxn?.completedSale?.cashAmount ?? paymentFlow.amount) || 0;
  const paymentFlowGcashPaid = Number(paymentFlow.completedTxn?.completedSale?.gcashAmount ?? paymentFlow.gcashAmount) || 0;
  const paymentFlowChange = Math.max(0, paymentFlowCashPaid + paymentFlowGcashPaid - total);
  const paymentFlowTransactionNo = paymentFlow.completedTxn?.completedSale?.transactionNo
    || paymentFlow.completedTxn?.transactionNo
    || activeTxn.transactionNo;

  const filteredProducts = useMemo(() => {
    const query = searchProduct.trim().toLowerCase();
    if (!query) return [];
    return products.filter((product) =>
      product.name.toLowerCase().includes(query) ||
      String(product.barcode || '').toLowerCase().includes(query) ||
      normalizeSellingUnits(product).some((unit) => (
        String(unit.barcode || '').toLowerCase().includes(query) ||
        String(unit.unit || '').toLowerCase().includes(query)
      ))
    ).slice(0, 8);
  }, [products, searchProduct]);
  const selectedSearchProduct = filteredProducts[selectedSearchIndex];

  const filteredHistoryRecords = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) return historyRecords;
    return historyRecords.filter((sale) =>
      String(sale.transactionNo || '').toLowerCase().includes(query)
    );
  }, [historyRecords, historySearch]);

  const completedCashSales = useMemo(() => transactions.reduce((sum, txn) => {
    const sale = txn.completedSale;
    if (!sale || txn.status !== 'completed') return sum;
    if (sale.paymentMethod === 'cash') return sum + (Number(sale.totalAmount) || 0);
    if (sale.paymentMethod === 'split') return sum + (Number(sale.splitPayments?.cash ?? sale.cashAmount) || 0);
    return sum;
  }, 0), [transactions]);

  const shiftCashIn = Number(shiftSession?.cashIn) || 0;
  const shiftCashOut = Number(shiftSession?.cashOut) || 0;
  const shiftOpeningCash = Number(shiftSession?.openingAmount) || 0;
  const expectedShiftCash = shiftOpeningCash + completedCashSales + shiftCashIn - shiftCashOut;
  const cashFlowNet = shiftCashIn - shiftCashOut;
  const recentCashCountHistory = cashCountHistory
    .filter((entry) => !user?.id || String(entry.cashierId || '') === String(user.id))
    .slice(0, 3);
  const auditDenominationTotal = useMemo(() => (
    DENOMINATIONS.reduce((sum, denomination) => (
      sum + ((Number(cashierAuditEntry.denominations?.[denomination]) || 0) * denomination)
    ), 0)
  ), [cashierAuditEntry.denominations]);
  const auditCountMode = cashierAuditEntry.countMode || 'manual';
  const auditActualCashEnding = auditCountMode === 'denomination'
    ? auditDenominationTotal
    : Number(cashierAuditEntry.actualCashEnding || cashierAuditEntry.cashOnHand || 0);
  const auditVariance = auditActualCashEnding - expectedShiftCash;
  const shiftCloseDenominationTotal = useMemo(() => (
    DENOMINATIONS.reduce((sum, denomination) => (
      sum + ((Number(shiftCloseDenominations[denomination]) || 0) * denomination)
    ), 0)
  ), [shiftCloseDenominations]);
  const shiftCloseBreakdown = useMemo(() => (
    DENOMINATIONS.map((denomination) => ({
      denomination,
      count: Number(shiftCloseDenominations[denomination]) || 0,
    })).filter((item) => item.count > 0)
  ), [shiftCloseDenominations]);
  const shiftCloseActualCashEnding = shiftCloseCountMode === 'denomination'
    ? shiftCloseDenominationTotal
    : Number(shiftClosingAmount || 0);

  const getReservedBaseQuantity = (productId, excludedCartItemId = null, excludedTransactionId = null) => {
    const normalizedProductId = String(productId || '')
    return transactions.reduce((sum, txn) => {
      // Only consider active/pending transactions when reserving stock.
      if (txn.id === excludedTransactionId) return sum;
      if (txn.status === 'completed' || txn.status === 'voided') return sum;
      return txn.cartItems.reduce((innerSum, cartItem) => {
        const itemProductId = String(cartItem.productId || cartItem.id || '')
        const itemId = String(cartItem.id || '')
        if (itemProductId !== normalizedProductId) return innerSum
        if (excludedCartItemId && itemId === excludedCartItemId) return innerSum
        return innerSum + toBaseStockQuantity(cartItem.quantity, cartItem.conversion)
      }, sum)
    }, 0)
  };

  const getRemainingStock = (item, excludedTransactionId = null, excludedCartItemId = null) => {
    const productId = String(item.productId || item.id || '')
    const baseQty = Number(item.stockQty ?? item.qty) || 0
    const reserved = getReservedBaseQuantity(productId, excludedCartItemId, excludedTransactionId)
    return Math.max(0, baseQty - reserved)
  };

  const stockForProduct = (item, excludedTransactionId = null) => {
    const productId = item.productId || item.id;
    const source = products.find((product) => product.id === productId) || item;
    return getRemainingStock(source, excludedTransactionId);
  };

  const pendingCartUnits = pendingCartProduct ? normalizeSellingUnits(pendingCartProduct) : [];
  const pendingCartSelectedUnit = pendingCartUnits.find((unit) => sellingUnitKey(unit) === pendingCartUnitKey)
    || (pendingCartProduct ? findSellingUnit(pendingCartProduct) : null);
  const pendingCartConversion = Number(pendingCartSelectedUnit?.conversion) > 0 ? Number(pendingCartSelectedUnit.conversion) : 1;
  const pendingCartAvailableQty = pendingCartProduct
    ? Math.floor(stockForProduct(pendingCartProduct) / pendingCartConversion)
    : 0;

  const updateActiveTransaction = (changes) => {
    setTransactions((current) => current.map((txn) => (
      txn.id === activeTransaction
        ? { ...txn, ...(typeof changes === 'function' ? changes(txn) : changes) }
        : txn
    )));
  };

  const updateTransactionById = (transactionId, changes) => {
    setTransactions((current) => current.map((txn) => (
      txn.id === transactionId
        ? { ...txn, ...(typeof changes === 'function' ? changes(txn) : changes) }
        : txn
    )));
  };

  const showNotification = (message) => {
    setNotification(message);
    window.setTimeout(() => setNotification(''), 3200);
  };

  const withDevice = (detail) => `${detail} Device ${deviceId}.`;

  const sameCashier = (candidate) => {
    if (!candidate) return false;
    if (user?.id && candidate.id) return String(candidate.id) === String(user.id);
    return String(candidate.email || '').toLowerCase() === String(user?.email || '').toLowerCase();
  };

  const lockForIdle = () => {
    setIdleLocked(true);
    setIdleUnlockBarcode('');
    setIdleUnlockPassword('');
    setIdleUnlockError('');
    cashierApi.logActivity({
      cashierId: user?.id,
      action: 'Session Locked',
      detail: withDevice(`Cashier session locked after inactivity for ${user?.name || user?.email || 'Cashier'}.`),
    }).catch(() => {});
  };

  const unlockIdleSession = async () => {
    setIdleUnlockError('');
    setIdleUnlocking(true);
    try {
      const session = idleUnlockMode === 'barcode'
        ? await cashierApi.loginWithBarcode(idleUnlockBarcode)
        : await cashierApi.login(user?.email || '', idleUnlockPassword);
      if (!sameCashier(session.user)) {
        setIdleUnlockError('Use the same cashier account to unlock this session.');
        return;
      }
      setIdleLocked(false);
      setIdleUnlockBarcode('');
      setIdleUnlockPassword('');
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Session Unlocked',
        detail: withDevice(`Cashier session unlocked by ${user?.name || user?.email || 'Cashier'}.`),
      }).catch(() => {});
    } catch (err) {
      cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Security Alert',
        detail: withDevice(`Failed unlock attempt for ${user?.name || user?.email || 'Cashier'} using ${idleUnlockMode}.`),
      }).catch(() => {});
      setIdleUnlockError((typeof err === 'string' ? err : err.message) || 'Unable to unlock session.');
    } finally {
      setIdleUnlocking(false);
    }
  };

  const updateReceiptPrintJob = (jobId, updates) => {
    setReceiptPrintQueue((current) => current.map((job) => (
      job.id === jobId ? { ...job, ...updates } : job
    )));
  };

  const removeReceiptPrintJobLater = (jobId) => {
    window.setTimeout(() => {
      setReceiptPrintQueue((current) => current.filter((job) => job.id !== jobId));
    }, 6000);
  };

  const refreshPrinterQueue = async () => {
    try {
      const status = await getReceiptPrinterStatus();
      setPrinterQueueJobs(Array.isArray(status.jobs) ? status.jobs : []);
      return status;
    } catch {
      setPrinterQueueJobs([]);
      return null;
    }
  };

  const waitForPrinterQueueToClear = async (transactionNo) => {
    const receiptLabel = `Receipt ${transactionNo}`;
    let lastStatus = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      lastStatus = await refreshPrinterQueue();
      const jobs = Array.isArray(lastStatus?.jobs) ? lastStatus.jobs : [];
      const matchingJobs = jobs.filter((job) => String(job.document || '').includes(receiptLabel));

      if (!matchingJobs.length && lastStatus?.isReady !== false) return;
      if (lastStatus?.isReady === false) {
        throw new Error((lastStatus.messages || []).join(' ') || 'Printer needs attention.');
      }
    }

    const queueJobs = Array.isArray(lastStatus?.jobs) ? lastStatus.jobs : [];
    const matchingJobs = queueJobs.filter((job) => String(job.document || '').includes(receiptLabel));
    if (matchingJobs.length) {
      throw new Error(`Receipt ${transactionNo} is still in the Windows printer queue. Check paper, printer power, and printer errors before printing again.`);
    }
  };

  const receiptPrintKey = (txn, copyStep) => `${txn?.completedSale?.transactionNo || txn?.transactionNo || txn?.id || 'receipt'}:${copyStep}`;

  const isReceiptPrintBusy = (txn, step = 'reprint') => {
    const copyStep = step === 'initial' ? 'initial' : (txn?.completedSale?.receiptPrinted ? 'reprint' : 'initial');
    return receiptPrintLocksRef.current.has(receiptPrintKey(txn, copyStep));
  };

  const saveReceiptSettings = (updates) => {
    setReceiptSettings((current) => {
      const next = {
        ...current,
        ...updates,
      };
      localStorage.setItem(RECEIPT_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const saveShortcutSettings = (updates) => {
    setShortcutSettings((current) => {
      const next = {
        ...current,
        ...updates,
        shortcuts: {
          ...current.shortcuts,
          ...(updates.shortcuts || {}),
        },
      };
      localStorage.setItem(CASHIER_SHORTCUT_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const setShortcut = (action, value) => {
    saveShortcutSettings({
      shortcuts: {
        [action]: normalizeShortcut(value),
      },
    });
  };

  const shortcutFor = (action) => normalizeShortcut(shortcutSettings.shortcuts[action]);

  const updateCashierAuditEntry = (key, value) => {
    setCashierAuditEntry((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem(CASHIER_AUDIT_ENTRY_KEY, JSON.stringify(next));
      return next;
    });
    setCashierAuditMessage('');
  };

  const updateAuditDenomination = (denomination, value) => {
    setCashierAuditEntry((current) => {
      const denominations = {
        ...(current.denominations || {}),
        [denomination]: Math.max(0, Math.floor(Number(value) || 0)),
      };
      const next = {
        ...current,
        denominations,
        countMode: 'denomination',
        cashOnHand: String(DENOMINATIONS.reduce((sum, item) => (
          sum + ((Number(denominations[item]) || 0) * item)
        ), 0)),
        actualCashEnding: String(DENOMINATIONS.reduce((sum, item) => (
          sum + ((Number(denominations[item]) || 0) * item)
        ), 0)),
      };
      localStorage.setItem(CASHIER_AUDIT_ENTRY_KEY, JSON.stringify(next));
      return next;
    });
    setCashierAuditMessage('');
  };

  const persistShiftSession = (session) => {
    setShiftSession(session);
    localStorage.setItem(shiftStorageKey(user?.id), JSON.stringify(session));
  };

  const resetShiftCloseForm = () => {
    setShiftCloseCountMode('denomination');
    setShiftCloseDenominations({});
    setShiftClosingAmount(String(expectedShiftCash.toFixed(2)));
    setShiftNote('');
    setShiftError('');
  };

  const updateShiftCloseDenomination = (denomination, value) => {
    setShiftCloseDenominations((current) => ({
      ...current,
      [denomination]: Math.max(0, Math.floor(Number(value) || 0)),
    }));
    setShiftError('');
  };

  useEffect(() => {
    if (shiftCloseCountMode === 'denomination') {
      const hasCounts = Object.values(shiftCloseDenominations).some((count) => Number(count) > 0);
      if (hasCounts) {
        setShiftClosingAmount(String(shiftCloseDenominationTotal.toFixed(2)));
      }
    }
  }, [shiftCloseCountMode, shiftCloseDenominationTotal, shiftCloseDenominations]);

  const openShift = async () => {
    const openingAmount = Number(shiftOpeningAmount);
    if (!Number.isFinite(openingAmount) || openingAmount < 0) {
      setShiftError('Enter a valid cash beginning amount.');
      return;
    }

    setShiftSaving(true);
    setShiftError('');
    try {
      const session = {
        id: `shift_${Date.now()}`,
        status: 'open',
        cashierId: user?.id || '',
        cashierName: user?.name || user?.email || 'Cashier',
        openingAmount,
        cashIn: 0,
        cashOut: 0,
        openedAt: new Date().toISOString(),
        note: shiftNote.trim(),
        deviceId,
      };
      const cloudSession = await cashierApi.openCashRegisterSession?.(session).catch(() => null);
      const savedSession = cloudSession?.id ? { ...session, id: cloudSession.id } : session;
      persistShiftSession(savedSession);
      setCashierAuditEntry((current) => {
        const next = { ...current, cashBeginning: String(openingAmount) };
        localStorage.setItem(CASHIER_AUDIT_ENTRY_KEY, JSON.stringify(next));
        return next;
      });
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Shift Open',
        detail: withDevice(`Shift opened by ${session.cashierName}: beginning PHP ${openingAmount.toFixed(2)}${session.note ? `; note ${session.note}` : ''}.`),
      }).catch(() => {});
      setShowShiftOpen(false);
      setShiftOpeningAmount('');
      setShiftNote('');
      showNotification(`Shift opened with ${money(openingAmount)}.`);
    } finally {
      setShiftSaving(false);
    }
  };

  const closeShift = async (skipCashCount = false) => {
    const closingAmount = skipCashCount ? expectedShiftCash : (
      shiftCloseCountMode === 'denomination'
        ? shiftCloseDenominationTotal
        : Number(shiftClosingAmount)
    );
    if (!Number.isFinite(closingAmount) || closingAmount < 0) {
      setShiftError('Enter a valid actual cash ending amount.');
      return;
    }

    setShiftSaving(true);
    setShiftError('');
    try {
      const variance = closingAmount - expectedShiftCash;
      // Only include denomination breakdown if: not admin override AND denomination mode was used
      const denominationBreakdown = skipCashCount ? [] : (
        shiftCloseCountMode === 'denomination'
          ? shiftCloseBreakdown
          : []
      );
      // Determine the count mode: admin-override takes precedence, then denomination vs manual
      const countModeUsed = skipCashCount ? 'admin-override' : shiftCloseCountMode;
      const closed = {
        ...shiftSession,
        status: 'closed',
        closingAmount,
        expectedClosingAmount: expectedShiftCash,
        variance,
        countMode: countModeUsed,
        denominations: denominationBreakdown,
        closedAt: new Date().toISOString(),
        closeNote: shiftNote.trim(),
        deviceId,
      };
      await cashierApi.closeCashRegisterSession?.(closed).catch(() => {});
      const denominationSummary = denominationBreakdown.length > 0
        ? `; denominations: ${denominationBreakdown.map(d => `${d.count}x${d.denomination}`).join(', ')}`
        : '';
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Shift Close',
        detail: withDevice(`Shift closed by ${closed.cashierName || user?.name || user?.email || 'Cashier'}: beginning PHP ${shiftOpeningCash.toFixed(2)}, cash sales PHP ${completedCashSales.toFixed(2)}, cash in PHP ${shiftCashIn.toFixed(2)}, cash out PHP ${shiftCashOut.toFixed(2)}, expected PHP ${expectedShiftCash.toFixed(2)}, actual PHP ${closingAmount.toFixed(2)}, variance PHP ${variance.toFixed(2)}, count mode: ${countModeUsed}${skipCashCount ? '; admin override: admin' : ''}${denominationSummary}${closed.closeNote ? `; note ${closed.closeNote}` : ''}.`),
      }).catch(() => {});
      appendCashCountHistory({
        type: skipCashCount ? 'admin-override-close' : 'shift-close',
        cashierId: closed.cashierId || user?.id || '',
        cashierName: closed.cashierName || user?.name || user?.email || 'Cashier',
        countedAt: closed.closedAt,
        openingAmount: shiftOpeningCash,
        cashSales: completedCashSales,
        cashIn: shiftCashIn,
        cashOut: shiftCashOut,
        expectedCash: expectedShiftCash,
        actualCash: closingAmount,
        variance,
        countMode: countModeUsed,
        denominations: denominationBreakdown,
        deviceId,
      });
      if (!skipCashCount) {
        try {
          await printShiftCloseReceipt({
            cashierName: closed.cashierName || user?.name || user?.email || 'Cashier',
            openedAt: shiftSession?.openedAt,
            closedAt: closed.closedAt,
            openingAmount: shiftOpeningCash,
            cashSales: completedCashSales,
            cashIn: shiftCashIn,
            cashOut: shiftCashOut,
            expectedCash: expectedShiftCash,
            actualCash: closingAmount,
            variance,
            countMode: countModeUsed,
            denominations: denominationBreakdown,
          }, { documentName: `Shift Close ${closed.cashierName || user?.name || user?.email || 'Cashier'}` });
        } catch (printError) {
          showNotification((typeof printError === 'string' ? printError : printError?.message) || 'Shift close receipt could not be printed.');
        }
      }
      localStorage.removeItem(shiftStorageKey(user?.id));
      setShiftSession(null);
      setShowShiftClose(false);
      setShowAdminLogout(false);
      resetShiftCloseForm();
      showNotification(`Shift closed${skipCashCount ? ' (admin override)' : ''}. Variance: ${money(variance)}.`);
      if (onLogout) {
        onLogout();
        navigate('/login');
      }
    } finally {
      setShiftSaving(false);
    }
  };

  const saveCashierAuditEntry = async () => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      setCashierAuditMessage('Open a shift before saving a cash audit.');
      return;
    }
    const cashBeginning = Number(cashierAuditEntry.cashBeginning);
    const cashEnding = Number(cashierAuditEntry.cashEnding || expectedShiftCash);
    const countMode = cashierAuditEntry.countMode || 'manual';
    const denominationBreakdown = DENOMINATIONS
      .map((denomination) => ({
        denomination,
        count: Number(cashierAuditEntry.denominations?.[denomination]) || 0,
      }))
      .filter((item) => item.count > 0);
    const breakdownText = denominationBreakdown
      .map((item) => `${item.denomination}x${item.count}`)
      .join(', ');
    const cashOnHand = countMode === 'denomination'
      ? auditDenominationTotal
      : Number(cashierAuditEntry.cashOnHand || cashierAuditEntry.actualCashEnding);
    const actualCashEnding = countMode === 'denomination'
      ? auditDenominationTotal
      : Number(cashierAuditEntry.actualCashEnding || cashOnHand);

    if (![cashBeginning, cashEnding, cashOnHand, actualCashEnding].every((value) => Number.isFinite(value) && value >= 0)) {
      setCashierAuditMessage('Enter valid cash beginning, ending, actual ending, and on-hand amounts.');
      return;
    }

    setCashierAuditSaving(true);
    try {
      const opened = await openCashRegisterForActivity(
        'cash audit',
        `Cash register opened for cash audit by ${user?.name || user?.email || 'Cashier'}.`
      );
      if (!opened) {
        setCashierAuditMessage('Unable to open cash register for audit.');
        return;
      }
      await cashierApi.recordCashAudit?.({
        sessionId: shiftSession.id,
        cashierId: user?.id,
        cashBeginning,
        cashSales: completedCashSales,
        cashIn: shiftCashIn,
        cashOut: shiftCashOut,
        expectedCash: expectedShiftCash,
        cashEnding,
        actualCash: actualCashEnding,
        cashOnHand,
        denominationTotal: auditDenominationTotal,
        variance: actualCashEnding - expectedShiftCash,
        countMode,
        denominations: denominationBreakdown,
        note: cashierAuditEntry.note || '',
        deviceId,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Cash Audit',
        detail: withDevice(`Cash audit by ${user?.name || user?.email || 'Cashier'}: beginning PHP ${cashBeginning.toFixed(2)}, cash sales PHP ${completedCashSales.toFixed(2)}, cash in PHP ${shiftCashIn.toFixed(2)}, cash out PHP ${shiftCashOut.toFixed(2)}, expected PHP ${expectedShiftCash.toFixed(2)}, ending PHP ${cashEnding.toFixed(2)}, actual PHP ${actualCashEnding.toFixed(2)}, on hand PHP ${cashOnHand.toFixed(2)}, automatic cash count PHP ${auditDenominationTotal.toFixed(2)}, count mode ${countMode}${breakdownText ? `, breakdown ${breakdownText}` : ''}, variance PHP ${(actualCashEnding - expectedShiftCash).toFixed(2)}.`),
      });
      appendCashCountHistory({
        type: 'cash-audit',
        cashierId: user?.id || '',
        cashierName: user?.name || user?.email || 'Cashier',
        countedAt: new Date().toISOString(),
        openingAmount: cashBeginning,
        cashSales: completedCashSales,
        cashIn: shiftCashIn,
        cashOut: shiftCashOut,
        expectedCash: expectedShiftCash,
        actualCash: actualCashEnding,
        cashOnHand,
        variance: actualCashEnding - expectedShiftCash,
        countMode,
        denominations: denominationBreakdown,
        deviceId,
      });
      setCashierAuditMessage('Cash audit saved to activity logs. Register opened for count verification.');
      showNotification('Cash audit saved and register opened.');
    } catch (err) {
      setCashierAuditMessage((typeof err === 'string' ? err : err.message) || 'Unable to save cash audit.');
    } finally {
      setCashierAuditSaving(false);
    }
  };

  const openRegisterForAudit = async () => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      setCashierAuditMessage('Open a shift before opening the register for audit.');
      return;
    }
    const opened = await openCashRegisterForActivity(
      'cash audit',
      `Cash register opened for cash audit by ${user?.name || user?.email || 'Cashier'}.`
    );
    if (opened) setCashierAuditMessage('Register opened for cash audit.');
  };

  const ShortcutHint = ({ action }) => {
    const value = shortcutFor(action);
    if (!shortcutSettings.showLabels || !value) return null;
    return <span className={styles['shortcut-hint']}>{value}</span>;
  };

  const withShortcut = (label, action) => (
    <>
      <span>{label}</span>
      <ShortcutHint action={action} />
    </>
  );

  const focusLatestQuantityInput = () => {
    const latestItem = cartItems[cartItems.length - 1];
    if (!latestItem) {
      showNotification('Add an item before editing quantity.');
      return;
    }

    const input = quantityInputRefs.current.get(latestItem.id);
    input?.focus();
    input?.select?.();
  };

  const updateTheme = (enabled) => {
    const nextTheme = saveTheme(enabled ? THEMES.dark : THEMES.light);
    setTheme(nextTheme);
    showNotification(`${nextTheme === THEMES.dark ? 'Dark' : 'Light'} mode enabled.`);
  };

  const selectReceiptPdfDirectory = async () => {
    const invoke = tauriInvoke();
    if (!invoke) {
      showNotification('Folder browsing is only available in the desktop app.');
      return;
    }

    const selected = await invoke('select_export_folder');
    if (selected) saveReceiptSettings({ receiptPdfDirectory: selected });
  };

  const updateReceiptPrintState = (transactionId, printedStep) => {
    updateTransactionById(transactionId, (current) => ({
      completedSale: {
        ...current.completedSale,
        receiptPrintStep: nextReceiptStep(printedStep),
        receiptPrinted: true,
      },
    }));
  };

  const receiptDataForTransaction = (txn) => ({
    transactionNo: txn.completedSale.transactionNo || txn.transactionNo,
    cashierName: user?.name || user?.email || 'Cashier',
    completedAt: txn.completedSale.completedAt,
    items: txn.cartItems,
    payment: txn.completedSale,
  });

  const printReceiptCopy = async (txn, step, options = {}) => {
    const copyStep = step === 'reprint' ? 'reprint' : 'initial';
    const openDrawerBeforePrint = options.openDrawerBeforePrint ?? copyStep === 'initial';
    const confirmDrawerClosed = options.confirmDrawerClosed ?? copyStep === 'initial';
    const copyLabel = receiptStepLabel(copyStep);
    const transactionNo = txn.completedSale.transactionNo || txn.transactionNo;
    const jobKey = receiptPrintKey(txn, copyStep);

    if (receiptPrintLocksRef.current.has(jobKey)) {
      throw new Error(`Receipt ${transactionNo} is already in the print queue.`);
    }

    const jobId = ++receiptPrintJobIdRef.current;
    receiptPrintLocksRef.current.add(jobKey);
    setReceiptPrintQueue((current) => [
      ...current,
      {
        id: jobId,
        key: jobKey,
        transactionNo,
        label: copyLabel,
        status: 'Checking printer',
      },
    ]);

    try {
      const status = await refreshPrinterQueue();
      if (status && !status.isReady) {
        throw new Error((status.messages || []).join(' ') || 'Printer is not ready.');
      }

      if (openDrawerBeforePrint) {
        updateReceiptPrintJob(jobId, { status: 'Opening drawer' });
        await openCashDrawer({ skipStatusCheck: true });
      }
      if (confirmDrawerClosed) {
        updateReceiptPrintJob(jobId, { status: 'Waiting for drawer close' });
        const drawerClosed = window.confirm('Close the cash drawer, then click OK to print the receipt.');
        if (!drawerClosed) throw new Error('Receipt printing paused until the cash drawer is closed.');
      }

      updateReceiptPrintJob(jobId, { status: 'Printing' });
      await printCompletedReceipt(receiptDataForTransaction(txn, copyLabel), {
        documentName: `Receipt ${transactionNo}`,
      });
      updateReceiptPrintJob(jobId, { status: 'Waiting for printer' });
      await waitForPrinterQueueToClear(transactionNo);
      updateReceiptPrintState(txn.id, copyStep);
      updateReceiptPrintJob(jobId, { status: 'Sent to printer' });
      removeReceiptPrintJobLater(jobId);
      return copyLabel;
    } catch (error) {
      updateReceiptPrintJob(jobId, {
        status: 'Needs attention',
        error: (typeof error === 'string' ? error : error.message) || 'Unable to print receipt.',
      });
      throw error;
    } finally {
      receiptPrintLocksRef.current.delete(jobKey);
    }
  };

  const handlePrintReceiptPdf = async (txn = activeTxn) => {
    if (!txn?.completedSale || txn.status !== 'completed') return;

    const requestedStep = txn.completedSale.receiptPrinted ? 'reprint' : 'initial';
    const copyLabel = receiptStepLabel(requestedStep);
    try {
      const result = await printReceiptPdf(receiptDataForTransaction(txn), {
        directory: receiptSettings.receiptPdfDirectory,
      });
      showNotification(`${copyLabel} PDF test saved to ${result.path}.`);
    } catch (err) {
      showNotification((typeof err === 'string' ? err : err.message) || 'Unable to open PDF test print.');
    }
  };

  async function loadProducts() {
    setProductsLoading(true);
    setProductsError('');
    try {
      setProducts(await cashierApi.products());
    } catch (err) {
      setProductsError(err.message || 'Unable to load products.');
    } finally {
      setProductsLoading(false);
    }
  }

  async function loadTransactionHistory() {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      setHistoryRecords(await cashierApi.salesHistory({}));
    } catch (err) {
      setHistoryError(err.message || 'Unable to load transaction history.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadNextTransactionNumber() {
    try {
      const result = await cashierApi.nextTransactionNumber();
      setNextTransactionNo(result.transactionNo || '');
      setTransactions((current) => {
        if (current.some((txn) => txn.cartItems.length > 0)) return current;
        const transactionNo = result.transactionNo || current[0]?.transactionNo;
        return current.map((txn, index) => ({
          ...txn,
          transactionNo: index === 0 ? transactionNo : nextLocalTransactionNo(transactionNo, index),
          name: `TXN ${index === 0 ? transactionNo : nextLocalTransactionNo(transactionNo, index)}`,
        }));
      });
    } catch (err) {
      showNotification(err.message || 'Unable to load next transaction number.');
    }
  }

  useEffect(() => {
    loadProducts();
    loadNextTransactionNumber();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, [activeTransaction]);

  useEffect(() => {
    if (!paymentFlow.open) return;
    window.requestAnimationFrame(() => {
      if (paymentFlow.step === 'amount') {
        paymentAmountInputRef.current?.focus();
        paymentAmountInputRef.current?.select?.();
      } else {
        paymentFlowPanelRef.current?.focus();
      }
    });
  }, [paymentFlow.open, paymentFlow.step]);

  useEffect(() => {
    const session = loadCashierShift(user?.id);
    setShiftSession(session);
    setShowShiftOpen(!session);
    if (session) {
      setCashierAuditEntry((current) => ({
        ...current,
        cashBeginning: current.cashBeginning || String(session.openingAmount ?? ''),
      }));
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user || idleLocked) return undefined;
    let timerId;
    const resetTimer = () => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(lockForIdle, IDLE_LOCK_MS);
    };
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      window.clearTimeout(timerId);
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [idleLocked, user?.id]);

  const handleSplitPaymentChange = (method, value) => {
    updateActiveTransaction((txn) => ({
      splitPayments: { ...txn.splitPayments, [method]: value },
    }));
  };

  const resetPaymentState = () => {
    updateActiveTransaction({
      cashAmount: '',
      gcashAmount: '',
      gcashRef: '',
      splitPayments: { cash: '', gcash: '', gcashRef: '' },
      isSplitPayment: false,
    });
  };

  const resetCompletedVoidState = () => {
    setShowCompletedVoidModal(false);
    setCompletedVoidTarget(null);
    setCompletedVoidApprovalMethod('barcode');
    setCompletedVoidCode('');
    setCompletedVoidEmail('');
    setCompletedVoidPassword('');
    setCompletedVoidReason('');
    setCompletedVoidError('');
    setCompletedVoidLoading(false);
  };

  const openDiscountModal = () => {
    if (isLockedTxn) return;
    setShowDiscountModal(true);
    setDiscountApprovalMethod('barcode');
    setDiscountApprovalCode('');
    setDiscountApprovalEmail('');
    setDiscountApprovalPassword('');
    setDiscountAmountInput('');
    setDiscountError('');
    setDiscountApproved(false);
  };

  const approvalPayload = ({ method, code, email, password }) => {
    if (method === 'barcode') return { code: code.trim() };
    return { email: email.trim(), password };
  };

  const approvalError = (method) => (
    method === 'barcode'
      ? 'Scan or enter the manager barcode.'
      : 'Enter the admin email and password.'
  );

  const resetLookupApproval = () => {
    setLookupApprovalMethod('barcode');
    setLookupApprovalCode('');
    setLookupApprovalEmail('');
    setLookupApprovalPassword('');
    setLookupReason('');
    setLookupNote('');
  };

  const resetReceiptLookupState = () => {
    setShowReceiptLookup(false);
    setLookupQuery('');
    setLookupSale(null);
    setLookupLoading(false);
    setLookupError('');
    setLookupMode('verify');
    setLookupReturnQty({});
    setLookupActionLoading(false);
    resetLookupApproval();
  };

  const selectedLookupReturnItems = () => {
    if (!lookupSale) return [];
    return (lookupSale.items || [])
      .map((item) => {
        const productId = String(item.productId || item.id || '');
        return {
          ...item,
          productId,
          quantity: Math.max(0, Number(lookupReturnQty[productId]) || 0),
        };
      })
      .filter((item) => item.quantity > 0);
  };

  const selectedLookupReturnTotal = () => (
    selectedLookupReturnItems().reduce((sum, item) => sum + (Number(item.quantity) * Number(item.price || 0)), 0)
  );

  const handleOpenReceiptLookup = () => {
    setShowReceiptLookup(true);
    setLookupQuery('');
    setLookupSale(null);
    setLookupError('');
    setLookupMode('verify');
    setLookupReturnQty({});
    resetLookupApproval();
  };

  const handleReceiptLookup = async () => {
    const transactionNo = lookupQuery.trim();
    if (!transactionNo) {
      setLookupError('Scan or enter a transaction number.');
      return;
    }

    setLookupLoading(true);
    setLookupError('');
    setLookupSale(null);
    try {
      const sale = await cashierApi.saleLookup({ transactionNo });
      setLookupSale(sale);
      setLookupMode('verify');
      setLookupReturnQty({});
      resetLookupApproval();
      cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Receipt Lookup',
        detail: `Looked up receipt for transaction ${sale.transactionNo}.`,
      }).catch(() => {});
    } catch (err) {
      setLookupError(err.message || 'Transaction was not found.');
    } finally {
      setLookupLoading(false);
    }
  };

  const handleLookupReprint = async () => {
    if (!lookupSale) return;
    try {
      await printCompletedReceipt({
        transactionNo: lookupSale.transactionNo,
        cashierName: lookupSale.cashierName || user?.name || user?.email || 'Cashier',
        completedAt: lookupSale.createdAt,
        items: lookupSale.items || [],
        payment: {
          paymentMethod: lookupSale.paymentMethod,
          totalAmount: lookupSale.totalAmount,
          subtotalAmount: lookupSale.subtotalAmount || lookupSale.totalAmount,
          discountPercent: lookupSale.discountPercent,
          discountAmount: lookupSale.discountAmount,
          cashAmount: lookupSale.cashAmount,
          gcashAmount: lookupSale.gcashAmount,
          splitPayments: lookupSale.splitPayments,
          change: lookupSale.change,
          gcashRef: lookupSale.refNumber,
        },
      });
      cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Receipt Reprint',
        detail: `Reprinted receipt for transaction ${lookupSale.transactionNo}.`,
      }).catch(() => {});
      showNotification(`Receipt reprinted for transaction ${lookupSale.transactionNo}.`);
    } catch (err) {
      setLookupError((typeof err === 'string' ? err : err.message) || 'Unable to reprint receipt.');
    }
  };

  const handleLookupPrintPdf = async () => {
    if (!lookupSale) return;
    try {
      const result = await printReceiptPdf({
        transactionNo: lookupSale.transactionNo,
        cashierName: lookupSale.cashierName || user?.name || user?.email || 'Cashier',
        completedAt: lookupSale.createdAt,
        items: lookupSale.items || [],
        payment: {
          paymentMethod: lookupSale.paymentMethod,
          totalAmount: lookupSale.totalAmount,
          subtotalAmount: lookupSale.subtotalAmount || lookupSale.totalAmount,
          discountPercent: lookupSale.discountPercent,
          discountAmount: lookupSale.discountAmount,
          cashAmount: lookupSale.cashAmount,
          gcashAmount: lookupSale.gcashAmount,
          change: lookupSale.change,
          splitPayments: lookupSale.splitPayments,
          gcashRef: lookupSale.refNumber,
        },
      }, {
        directory: receiptSettings.receiptPdfDirectory,
      });
      showNotification(`PDF test saved to ${result.path}.`);
    } catch (err) {
      setLookupError((typeof err === 'string' ? err : err.message) || 'Unable to open PDF test print.');
    }
  };

  const handleLookupApprovalAction = async () => {
    if (!lookupSale) return;

    const authorization = approvalPayload({
      method: lookupApprovalMethod,
      code: lookupApprovalCode,
      email: lookupApprovalEmail,
      password: lookupApprovalPassword,
    });
    if (!authorization.code && (!authorization.email || !authorization.password)) {
      setLookupError(approvalError(lookupApprovalMethod));
      return;
    }
    if (lookupMode !== 'void' && selectedLookupReturnItems().length === 0) {
      setLookupError('Select at least one item quantity.');
      return;
    }

    setLookupActionLoading(true);
    setLookupError('');

    try {
      const result = lookupMode === 'void'
        ? await cashierApi.voidCompletedSale({
            saleId: lookupSale.saleId || lookupSale.id,
            cashierId: user?.id,
            authorization,
            reason: lookupReason.trim(),
          })
        : await cashierApi.adjustCompletedSale({
            saleId: lookupSale.saleId || lookupSale.id,
            cashierId: user?.id,
            authorization,
            type: lookupMode,
            items: selectedLookupReturnItems().map((item) => ({
              productId: item.productId,
              name: item.name,
              barcode: item.barcode,
              quantity: item.quantity,
              price: item.price,
            })),
            reason: lookupReason.trim(),
            note: lookupNote.trim(),
          });

      await loadProducts();
      if (showHistory) await loadTransactionHistory();

      setTransactions((current) => current.map((txn) => {
        const matchesSale = txn.completedSale?.saleId === (lookupSale.saleId || lookupSale.id);
        if (!matchesSale) return txn;

        if (lookupMode === 'void') {
          return {
            ...txn,
            status: 'voided',
            completedSale: {
              ...txn.completedSale,
              status: 'voided',
              approvedBy: result.approvedBy,
              voidedAt: result.voidedAt,
              voidReason: lookupReason.trim(),
            },
          };
        }

        return {
          ...txn,
          completedSale: {
            ...txn.completedSale,
            status: 'adjusted',
            adjustments: result.adjustments || [],
          },
        };
      }));

      setLookupSale(lookupMode === 'void'
        ? { ...lookupSale, status: 'Voided', rawStatus: 'voided', voidedAt: result.voidedAt, approvedBy: result.approvedBy }
        : result
      );
      setLookupMode('verify');
      setLookupReturnQty({});
      resetLookupApproval();
      showNotification(
        lookupMode === 'void'
          ? `Transaction ${lookupSale.transactionNo} has been voided.`
          : `${lookupMode === 'exchange' ? 'Exchange' : 'Refund'} recorded for transaction ${lookupSale.transactionNo}.`
      );
    } catch (err) {
      setLookupError(err.message || `Unable to ${lookupMode} this transaction.`);
    } finally {
      setLookupActionLoading(false);
    }
  };

  const handleVoidTransaction = () => {
    if (isLockedTxn) return;
    setShowVoidAuth(true);
    setManagerBarcode('');
    setVoidError('');
  };

  const confirmVoidTransaction = async () => {
    try {
      await cashierApi.authorizeVoid(managerBarcode);
    } catch (err) {
      setVoidError(err.message || 'Manager barcode is not valid.');
      return;
    }

    const voidTotal = total;
    const voidItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    updateActiveTransaction({ cartItems: [], lastScanned: null, discount: 0 });
    resetPaymentState();
    try {
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Transaction Void',
        detail: `Voided transaction ${activeTxn.transactionNo} with ${voidItems} item(s), total ${money(voidTotal)}`,
      });
    } catch {
      // Do not block the cashier flow if audit logging fails.
    }
    setShowVoidAuth(false);
    setManagerBarcode('');
    setVoidError('');
    showNotification('Transaction has been voided.');
  };

  const openCashRegisterForActivity = async (reason, detail) => {
    try {
      await openCashDrawer({ skipStatusCheck: true });
      setCashRegisterOpen(true);
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Cash Register Opened',
        detail: withDevice(detail || `Cash register opened by ${user?.name || user?.email || 'Cashier'} for ${reason}.`),
      }).catch(() => {});
      return true;
    } catch (err) {
      setCashRegisterOpen(false);
      showNotification((typeof err === 'string' ? err : err.message) || 'Unable to open cash drawer.');
      return false;
    }
  };

  const resetCashFlowModal = () => {
    setShowCashFlowModal(false);
    setCashFlowType('out');
    setCashFlowAmount('');
    setCashFlowCategory(CASH_FLOW_CATEGORIES.out[0]);
    setCashFlowReason('');
    setCashFlowApprovalMethod('barcode');
    setCashFlowApprovalCode('');
    setCashFlowApprovalEmail('');
    setCashFlowApprovalPassword('');
    setCashFlowError('');
  };

  const openCashFlowModal = (type = 'out') => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      showNotification('Open a cashier shift before recording cash flow.');
      return;
    }
    setCashFlowType(type);
    setCashFlowCategory(CASH_FLOW_CATEGORIES[type]?.[0] || CASH_FLOW_CATEGORIES.out[0]);
    setShowCashFlowModal(true);
    setCashFlowError('');
  };

  const confirmCashFlow = async () => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      setCashFlowError('Open a cashier shift before recording cash flow.');
      return;
    }
    const amount = Number(cashFlowAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setCashFlowError('Enter a valid cash flow amount.');
      return;
    }

    try {
      const authorization = approvalPayload({
        method: cashFlowApprovalMethod,
        code: cashFlowApprovalCode,
        email: cashFlowApprovalEmail,
        password: cashFlowApprovalPassword,
      });
      if (!authorization.code && (!authorization.email || !authorization.password)) {
        setCashFlowError(approvalError(cashFlowApprovalMethod));
        return;
      }
      const approver = await cashierApi.authorizeVoid(authorization);
      const label = cashFlowType === 'in' ? 'Cash In' : 'Cash Out';
      const signedAmount = cashFlowType === 'in' ? amount : -amount;
      const opened = await openCashRegisterForActivity(
        label.toLowerCase(),
        `Cash register opened for ${label.toLowerCase()} PHP ${amount.toFixed(2)} by ${user?.name || user?.email || 'Cashier'}.`
      );
      if (!opened) {
        setCashFlowError('Manager approved, but the cash register did not open. Try again before moving cash.');
        return;
      }
      const nextSession = shiftSession
        ? {
            ...shiftSession,
            cashIn: (Number(shiftSession.cashIn) || 0) + (cashFlowType === 'in' ? amount : 0),
            cashOut: (Number(shiftSession.cashOut) || 0) + (cashFlowType === 'out' ? amount : 0),
          }
        : null;
      if (nextSession) persistShiftSession(nextSession);
      await cashierApi.recordCashMovement?.({
        sessionId: shiftSession.id,
        cashierId: user?.id,
        type: cashFlowType,
        amount,
        category: cashFlowCategory,
        note: cashFlowReason,
        approvedBy: approver?.id,
        approvalMethod: approver?.method || cashFlowApprovalMethod,
        deviceId,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: label,
        detail: withDevice(`${label} PHP ${amount.toFixed(2)} by ${user?.name || user?.email || 'Cashier'} approved by ${approver?.name || 'Manager'}; category ${cashFlowCategory}; signed PHP ${signedAmount.toFixed(2)}${cashFlowReason ? `; note ${cashFlowReason}` : ''}.`),
      });
      showNotification(`${label} recorded: ${money(amount)}.`);
      resetCashFlowModal();
    } catch (err) {
      cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Security Alert',
        detail: withDevice(`Failed cash flow attempt by ${user?.name || user?.email || 'Cashier'} for ${cashFlowType === 'in' ? 'cash in' : 'cash out'} PHP ${amount.toFixed(2)}.`),
      }).catch(() => {});
      setCashFlowError((typeof err === 'string' ? err : err.message) || 'Unable to record cash flow.');
    }
  };

  const handleOpenHistory = () => {
    setShowHistory(true);
    setHistorySearch('');
    loadTransactionHistory();
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const result = await cashierApi.syncNow();
      await loadProducts();
      if (showHistory) await loadTransactionHistory();
      showNotification(`Sync finished: ${result?.uploaded || 0} uploaded, ${result?.failed || 0} failed.`);
    } catch (err) {
      showNotification(err.message || 'Unable to sync right now.');
    } finally {
      setSyncing(false);
    }
  };

  const handleOpenCompletedVoidModal = (sale) => {
    setCompletedVoidTarget(sale);
    setCompletedVoidCode('');
    setCompletedVoidEmail('');
    setCompletedVoidPassword('');
    setCompletedVoidReason('');
    setCompletedVoidError('');
    setShowCompletedVoidModal(true);
  };

  const handleConfirmCompletedVoid = async () => {
    if (!completedVoidTarget?.saleId) {
      setCompletedVoidError('Completed sale reference is missing.');
      return;
    }

    const authorization = approvalPayload({
      method: completedVoidApprovalMethod,
      code: completedVoidCode,
      email: completedVoidEmail,
      password: completedVoidPassword,
    });

    if (!authorization.code && (!authorization.email || !authorization.password)) {
      setCompletedVoidError(approvalError(completedVoidApprovalMethod));
      return;
    }

    setCompletedVoidLoading(true);
    setCompletedVoidError('');

    try {
      const result = await cashierApi.voidCompletedSale({
        saleId: completedVoidTarget.saleId,
        cashierId: user?.id,
        authorization,
        reason: completedVoidReason.trim(),
      });

      setTransactions((current) => current.map((txn) => {
        const matchesSale = txn.completedSale?.saleId === completedVoidTarget.saleId;
        if (!matchesSale) return txn;

        return {
          ...txn,
          status: 'voided',
          completedSale: {
            ...txn.completedSale,
            status: 'voided',
            approvedBy: result.approvedBy,
            voidedAt: result.voidedAt,
            voidReason: completedVoidReason.trim(),
          },
        };
      }));

      await loadProducts();
      if (showHistory) await loadTransactionHistory();
      resetCompletedVoidState();
      showNotification(`Transaction ${result.transactionNo} has been voided.`);
    } catch (err) {
      setCompletedVoidError(err.message || 'Unable to void the completed transaction.');
    } finally {
      setCompletedVoidLoading(false);
    }
  };

  const openInitialQuantityPrompt = (product, preferredUnit = null) => {
    const selectedUnit = preferredUnit || findSellingUnit(product)
    const conversion = Number(selectedUnit?.conversion) > 0 ? Number(selectedUnit.conversion) : 1
    const availableQty = Math.floor(stockForProduct(product) / conversion)

    if (availableQty <= 0) {
      showNotification(`${product.name} is out of stock for ${selectedUnit?.unit || product.unit || 'this unit'}.`);
      return;
    }

    setPendingCartProduct(product);
    setPendingCartUnitKey(sellingUnitKey(selectedUnit));
    setInitialCartQuantity('1');
    setInitialCartQuantityError('');
    window.requestAnimationFrame(() => {
      initialQuantityInputRef.current?.focus();
      initialQuantityInputRef.current?.select?.();
    });
  };

  const closeInitialQuantityPrompt = () => {
    setPendingCartProduct(null);
    setPendingCartUnitKey('');
    setInitialCartQuantity('1');
    setInitialCartQuantityError('');
    window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
  };

  const appendCashCountHistory = (entry) => {
    setCashCountHistory((current) => {
      const next = [{ id: `${Date.now()}`, ...entry }, ...current].slice(0, 50);
      localStorage.setItem(CASHIER_CASH_COUNT_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  };

  const commitProductToCart = (product, quantity, unit = null) => {
    const selectedUnit = unit || findSellingUnit(product)
    const conversion = Number(selectedUnit?.conversion) > 0 ? Number(selectedUnit.conversion) : 1
    const unitName = String(selectedUnit?.unit || product.unit || 'Unit').trim() || 'Unit'
    const unitBarcode = String(selectedUnit?.barcode || '').trim()
    const unitPrice = Number(selectedUnit?.price) || Number(product.price) || 0
    const availableQty = Math.floor(stockForProduct(product) / conversion)
    const requestedQty = Math.floor(Number(quantity) || 0)

    if (requestedQty <= 0) {
      setInitialCartQuantityError('Enter a quantity of at least 1.')
      return false
    }

    if (requestedQty > availableQty) {
      setInitialCartQuantityError(`Only ${availableQty} ${pluralUnit(unitName, availableQty)} available for ${product.name}.`)
      return false
    }

    const itemId = `${product.id}:${sellingUnitKey(selectedUnit)}`
    const nextCartItems = (() => {
      const existing = cartItems.find((item) => item.id === itemId);
      if (existing) {
        const nextQuantity = existing.quantity + requestedQty
        return cartItems.map((item) =>
          item.id === itemId
            ? { ...item, quantity: nextQuantity, total: item.price * nextQuantity }
            : item
        );
      }

      return [
        ...cartItems,
        {
          id: itemId,
          productId: product.id,
          name: product.name,
          quantity: requestedQty,
          unit: unitName,
          price: unitPrice,
          conversion,
          stockQty: product.qty,
          lowStock: product.lowStock,
          barcode: unitBarcode || product.barcode,
          unitBarcode,
          category: product.category,
          imageUrl: product.imageUrl,
          image: product.image,
          total: unitPrice * requestedQty,
        },
      ];
    })();

    updateActiveTransaction({
      cartItems: nextCartItems,
      lastScanned: {
        name: product.name,
        barcode: unitBarcode || product.barcode,
        unit: unitName,
        price: unitPrice,
        conversion,
        productId: product.id,
        lowStock: product.lowStock,
        imageUrl: product.imageUrl,
        image: product.image,
      },
    });
    setSearchProduct('');
    setBarcode('');
    window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
    return true
  };

  const handleAddToCart = (product, preferredUnit = null) => {
    if (isLockedTxn) {
      showNotification('This transaction is already completed. Start a new transaction to continue selling.');
      return;
    }

    openInitialQuantityPrompt(product, preferredUnit);
  };

  const confirmInitialQuantity = () => {
    if (!pendingCartProduct) return;
    if (commitProductToCart(pendingCartProduct, initialCartQuantity, pendingCartSelectedUnit)) {
      closeInitialQuantityPrompt();
    }
  };

  const handleSearchKeyDown = (e) => {
    if (!searchProduct) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedSearchIndex((index) => Math.min(index + 1, Math.max(filteredProducts.length - 1, 0)));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedSearchIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedSearchProduct) handleAddToCart(selectedSearchProduct);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setSearchProduct('');
      barcodeInputRef.current?.focus();
    }
  };

  const handleSearchProductChange = (e) => {
    setSearchProduct(e.target.value);
    setSelectedSearchIndex(0);
  };

  const handleScan = async () => {
    if (isLockedTxn) {
      showNotification('This transaction is already completed. Start a new transaction to continue selling.');
      return;
    }
    const code = barcode.trim();
    if (!code) return;

    try {
      const product = await cashierApi.productByBarcode(code)
      handleAddToCart(product, findSellingUnit(product, code));
    } catch (err) {
      showNotification(err.message || 'Product not found.');
    }
  };

  const handleRemoveItem = (id) => {
    if (isLockedTxn) return;
    updateActiveTransaction({ cartItems: cartItems.filter((item) => item.id !== id) });
  };

  const handleQuantityChange = (id, value) => {
    if (isLockedTxn) return;
    const requested = Number(value);
    if (!Number.isFinite(requested)) return;

    updateActiveTransaction({
      cartItems: cartItems.map((item) => {
        if (item.id !== id) return item;
        const conversion = Number(item.conversion) > 0 ? Number(item.conversion) : 1
        const availableBase = getRemainingStock(item, activeTransaction, item.id)
        const maxAvailableQty = Math.max(1, Math.floor(availableBase / conversion));
        const maxQty = Math.max(1, Math.min(maxAvailableQty, Math.floor(requested)));

        if (requested > maxQty) {
          showNotification(`Only ${maxQty} ${pluralUnit(item.unit, maxQty)} available for ${item.name}.`);
        }

        return {
          ...item,
          quantity: maxQty,
          total: item.price * maxQty,
        };
      }),
    });
  };

  const adjustQuantity = (id, delta) => {
    const item = cartItems.find((cartItem) => cartItem.id === id);
    if (!item) return;
    handleQuantityChange(id, item.quantity + delta);
  };

  const completeActiveTransaction = async ({
    paidCashOverride,
    paidGcashOverride,
    splitPaymentsOverride,
    gcashRefOverride,
    paymentMethodOverride,
    isSplitPaymentOverride,
  } = {}) => {
    const completingTransactionId = activeTxn.id;
    const completedTransactionNo = activeTxn.transactionNo;
    const completedAt = new Date().toISOString();
    const effectiveIsSplitPayment = isSplitPaymentOverride ?? isSplitPayment;
    const effectivePaymentMethod = paymentMethodOverride || paymentMethod;
    const effectiveSplitPayments = splitPaymentsOverride || splitPayments;
    const effectiveGcashRef = gcashRefOverride ?? gcashRef;
    const paidCash = parseFloat(paidCashOverride ?? cashAmount) || 0;
    const paidGcash = parseFloat(paidGcashOverride ?? gcashAmount) || 0;
    const paidSplitCash = parseFloat(effectiveSplitPayments.cash) || 0;
    const paidSplitGcash = parseFloat(effectiveSplitPayments.gcash) || 0;
    const completedSplitPayments = {
      cash: paidSplitCash,
      gcash: paidSplitGcash,
      gcashRef: String(effectiveSplitPayments.gcashRef || '').trim(),
    };
    const completedItems = cartItems.map((item) => ({
      productId: item.productId,
      name: item.name,
      barcode: item.barcode,
      unit: item.unit,
      quantity: item.quantity,
      conversion: item.conversion,
      price: item.price,
    }));
    const completedPayment = {
      paymentMethod: effectiveIsSplitPayment ? 'split' : effectivePaymentMethod,
      totalAmount: total,
      subtotalAmount: subtotal,
      discountPercent: discount,
      discountAmount,
      cashAmount: effectiveIsSplitPayment ? paidSplitCash : paidCash,
      gcashAmount: effectiveIsSplitPayment ? paidSplitGcash : paidGcash,
      gcashRef: effectiveGcashRef,
      splitPayments: completedSplitPayments,
      change: effectiveIsSplitPayment
        ? Math.max(0, paidSplitCash + paidSplitGcash - total)
        : (effectivePaymentMethod === 'cash' ? paidCash - total : Math.max(0, paidGcash - total)),
      completedAt,
    };

    try {
      const sale = await cashierApi.completeSale({
        cashierId: user?.id,
        cashierName: user?.name || user?.email || 'Cashier',
        transactionNo: completedTransactionNo,
        subtotalAmount: subtotal,
        discountPercent: discount,
        discountAmount,
        totalAmount: total,
        paymentMethod: effectiveIsSplitPayment ? 'cash' : effectivePaymentMethod,
        cashAmount: completedPayment.cashAmount,
        gcashAmount: completedPayment.gcashAmount,
        splitPayments: completedSplitPayments,
        refNumber: effectiveIsSplitPayment ? `split:${JSON.stringify(completedSplitPayments)}` : effectiveGcashRef,
        items: completedItems,
      });

      await loadProducts();
      const result = await cashierApi.nextTransactionNumber();
      const transactionNo = result.transactionNo || nextLocalTransactionNo(completedTransactionNo);
      setNextTransactionNo(transactionNo);
      const newId = Math.max(...transactions.map((t) => t.id), 0) + 1;
      const completedSale = {
        ...completedPayment,
        saleId: sale.id,
        transactionNo: sale.transactionNo || completedTransactionNo,
        pendingSync: sale.pendingSync,
        discounted: discount > 0,
        receiptPrintStep: 'initial',
        receiptPrinted: false,
      };
      const completedTxn = {
        ...activeTxn,
        status: 'completed',
        completedSale,
      };
      updateTransactionById(completingTransactionId, {
        status: 'completed',
        completedSale,
      });
      setTransactions((current) => [...current, createTransaction(newId, transactionNo)]);
      setActiveTransaction(completingTransactionId);
      setSearchProduct('');
      setBarcode('');
      if (showHistory) loadTransactionHistory();
      showNotification(`Transaction No. ${sale.transactionNo || sale.id} completed.`);
      return completedTxn;
    } catch (err) {
      showNotification(err.message || 'Unable to complete transaction.');
      throw err;
    }
  };

  const closePaymentFlow = () => {
    if (paymentFlow.step !== 'amount') return;
    setPaymentFlow({
      open: false,
      step: 'amount',
      amount: '',
      gcashAmount: '',
      gcashRef: '',
      splitPayments: { cash: '', gcash: '', gcashRef: '' },
      method: 'cash',
      error: '',
      busy: false,
      completedTxn: null,
    });
    window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
  };

  const openPaymentFlow = () => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      showNotification('Open a cashier shift before completing sales.');
      return;
    }
    if (isLockedTxn) {
      alert(isVoidedTxn ? 'This transaction has already been voided.' : 'This transaction is already completed.');
      return;
    }
    if (cartItems.length === 0) {
      alert('Add items to the cart before completing the transaction.');
      return;
    }

    const method = isSplitPayment ? 'split' : paymentMethod;
    setPaymentFlow({
      open: true,
      step: 'amount',
      method,
      amount: method === 'cash' ? (cashAmount || String(total)) : '',
      gcashAmount: method === 'gcash' ? (gcashAmount || String(total)) : '',
      gcashRef: method === 'gcash' ? gcashRef : '',
      splitPayments: method === 'split'
        ? {
            cash: splitPayments.cash || '',
            gcash: splitPayments.gcash || '',
            gcashRef: splitPayments.gcashRef || '',
          }
        : { cash: '', gcash: '', gcashRef: '' },
      error: '',
      busy: false,
      completedTxn: null,
    });
    window.requestAnimationFrame(() => {
      paymentAmountInputRef.current?.focus();
      paymentAmountInputRef.current?.select?.();
    });
  };

  const advancePaymentFlow = async () => {
    if (!paymentFlow.open || paymentFlow.busy) return;

    if (paymentFlow.step === 'amount') {
      const method = paymentFlow.method || 'cash';
      const paidCash = parseFloat(paymentFlow.amount) || 0;
      const paidGcash = parseFloat(paymentFlow.gcashAmount) || 0;
      const flowSplitPayments = paymentFlow.splitPayments || { cash: '', gcash: '', gcashRef: '' };
      const splitCash = parseFloat(flowSplitPayments.cash) || 0;
      const splitGcash = parseFloat(flowSplitPayments.gcash) || 0;
      const splitTotal = splitCash + splitGcash;
      const flowGcashRef = String(paymentFlow.gcashRef || '').trim();
      const flowSplitGcashRef = String(flowSplitPayments.gcashRef || '').trim();

      if (method === 'cash' && (!paymentFlow.amount || paidCash < total)) {
        setPaymentFlow((current) => ({
          ...current,
          error: `Enter at least ${money(total)} to complete this cash sale.`,
        }));
        return;
      }
      if (method === 'gcash' && (!paymentFlow.gcashAmount || paidGcash < total)) {
        setPaymentFlow((current) => ({
          ...current,
          error: `Enter at least ${money(total)} to complete this GCash sale.`,
        }));
        return;
      }
      if (method === 'gcash' && !flowGcashRef) {
        setPaymentFlow((current) => ({ ...current, error: 'Enter the GCash reference number.' }));
        return;
      }
      if (method === 'split' && splitTotal < total) {
        setPaymentFlow((current) => ({
          ...current,
          error: `Split payment must total at least ${money(total)}.`,
        }));
        return;
      }
      if (method === 'split' && splitGcash > 0 && !flowSplitGcashRef) {
        setPaymentFlow((current) => ({ ...current, error: 'Enter the GCash reference number for the split payment.' }));
        return;
      }

      setPaymentFlow((current) => ({ ...current, busy: true, error: '' }));
      try {
        if (method === 'cash') updateActiveTransaction({ cashAmount: String(paidCash) });
        if (method === 'gcash') updateActiveTransaction({ gcashAmount: String(paidGcash), gcashRef: flowGcashRef });
        if (method === 'split') updateActiveTransaction({ splitPayments: flowSplitPayments });
        const completedTxn = await completeActiveTransaction({
          paidCashOverride: method === 'cash' ? paidCash : 0,
          paidGcashOverride: method === 'gcash' ? paidGcash : 0,
          splitPaymentsOverride: flowSplitPayments,
          gcashRefOverride: method === 'gcash' ? flowGcashRef : '',
          paymentMethodOverride: method === 'split' ? 'cash' : method,
          isSplitPaymentOverride: method === 'split',
        });
        setPaymentFlow((current) => ({
          ...current,
          busy: false,
          step: method === 'cash' || (method === 'split' && splitCash > 0) ? 'change' : 'receipt',
          amount: String(paidCash),
          gcashAmount: String(paidGcash),
          splitPayments: flowSplitPayments,
          completedTxn,
        }));
      } catch (err) {
        setPaymentFlow((current) => ({
          ...current,
          busy: false,
          error: (typeof err === 'string' ? err : err.message) || 'Unable to complete transaction.',
        }));
      }
      return;
    }

    if (paymentFlow.step === 'change') {
      setPaymentFlow((current) => ({ ...current, busy: true, error: '' }));
      try {
        const txn = paymentFlow.completedTxn;
        await openCashRegisterForActivity(
          'completed transaction',
          `Cash register opened after completed transaction ${txn?.completedSale?.transactionNo || txn?.transactionNo || activeTxn.transactionNo}.`
        );
        setPaymentFlow((current) => ({ ...current, busy: false, step: 'register' }));
      } catch (err) {
        setPaymentFlow((current) => ({
          ...current,
          busy: false,
          error: (typeof err === 'string' ? err : err.message) || 'Unable to open cash register.',
        }));
      }
      return;
    }

    if (paymentFlow.step === 'register' || paymentFlow.step === 'receipt') {
      const txn = paymentFlow.completedTxn;
      if (!txn) {
        setPaymentFlow((current) => ({ ...current, open: false, step: 'amount' }));
        return;
      }
      setPaymentFlow((current) => ({ ...current, busy: true, error: '' }));
      try {
        await printReceiptCopy(txn, 'initial', {
          openDrawerBeforePrint: false,
          confirmDrawerClosed: false,
        });
        showNotification(`Receipt printed for transaction ${txn.completedSale.transactionNo || txn.transactionNo}.`);
        setPaymentFlow({
          open: false,
          step: 'amount',
          method: 'cash',
          amount: '',
          gcashAmount: '',
          gcashRef: '',
          splitPayments: { cash: '', gcash: '', gcashRef: '' },
          error: '',
          busy: false,
          completedTxn: null,
        });
        window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
      } catch (err) {
        setPaymentFlow((current) => ({
          ...current,
          busy: false,
          error: (typeof err === 'string' ? err : err.message) || 'Unable to print receipt.',
        }));
      }
    }
  };

  const handleCompleteTransaction = async () => {
    if (!shiftSession) {
      setShowShiftOpen(true);
      showNotification('Open a cashier shift before completing sales.');
      return;
    }

    openPaymentFlow();
  };

  const handleReprintReceipt = async (txn = activeTxn) => {
    if (!txn?.completedSale || txn.status !== 'completed') return;

    try {
      const requestedStep = txn.completedSale.receiptPrinted ? 'reprint' : 'initial';
      const copyLabel = await printReceiptCopy(txn, requestedStep);
      cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Receipt Reprint',
        detail: `Printed ${copyLabel.toLowerCase()} for transaction ${txn.completedSale.transactionNo || txn.transactionNo}.`,
      }).catch(() => {});
      showNotification(`${copyLabel} printed for transaction ${txn.completedSale.transactionNo || txn.transactionNo}.`);
    } catch (err) {
      showNotification((typeof err === 'string' ? err : err.message) || 'Unable to reprint receipt.');
    }
  };

  const handleNewTransaction = () => {
    const newId = Math.max(...transactions.map((t) => t.id), 0) + 1;
    const transactionNo = transactions.reduce((latest, txn) => (
      String(txn.transactionNo) > String(latest) ? txn.transactionNo : latest
    ), nextTransactionNo || activeTxn.transactionNo);
    setTransactions([...transactions, createTransaction(newId, nextLocalTransactionNo(transactionNo))]);
    setActiveTransaction(newId);
    setSearchProduct('');
    setBarcode('');
  };

  const handleDeleteTransaction = (txnId) => {
    const target = transactions.find((txn) => txn.id === txnId);
    if (target?.status === 'completed' && !confirm(`Close completed transaction ${target.transactionNo}?`)) return;
    const remaining = transactions.filter((t) => t.id !== txnId);
    if (remaining.length === 0) {
      const nextTransaction = createTransaction(1);
      setTransactions([nextTransaction]);
      setActiveTransaction(nextTransaction.id);
      setSearchProduct('');
      setBarcode('');
      return;
    }
    setTransactions(remaining);
    if (activeTransaction === txnId) setActiveTransaction(remaining[0].id);
  };

  const approveAdminLogout = async () => {
    setAdminLogoutError('');
    setAdminLogoutBusy(true);
    try {
      if (adminLogoutApprovalMethod === 'barcode') {
        await cashierApi.authorizeVoid(adminLogoutApprovalCode);
      } else {
        await cashierApi.authorizeVoid({
          email: adminLogoutApprovalEmail,
          password: adminLogoutApprovalPassword,
        });
      }
      setAdminLogoutApproved(true);
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Admin Logout Request',
        detail: withDevice(`${user?.name || user?.email || 'Cashier'} requested admin logout override.`),
      }).catch(() => {});
    } catch (err) {
      setAdminLogoutError((typeof err === 'string' ? err : err.message) || 'Invalid credentials.');
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Admin Logout Security Alert',
        detail: withDevice(`Failed admin logout attempt by ${user?.name || user?.email || 'Cashier'}.`),
      }).catch(() => {});
    } finally {
      setAdminLogoutBusy(false);
    }
  };

  const confirmAdminLogoutOnly = async () => {
    setAdminLogoutBusy(true);
    setAdminLogoutError('');
    try {
      await cashierApi.logActivity({
        cashierId: user?.id,
        action: 'Admin Logout',
        detail: withDevice(`${user?.name || user?.email || 'Cashier'} logged out with admin approval. Shift remains open; no cash count or shift close was recorded.`),
      }).catch(() => {});
      setShowAdminLogout(false);
      setShowShiftClose(false);
      if (onLogout) {
        onLogout();
        navigate('/login');
      }
    } finally {
      setAdminLogoutBusy(false);
    }
  };

  const handleLogout = () => {
    if (shiftSession) {
      resetShiftCloseForm();
      setShowShiftClose(true);
      return;
    }
    if (onLogout) {
      onLogout();
      navigate('/login');
    }
  };

  useEffect(() => {
    const modalOpen = idleLocked || Boolean(pendingCartProduct) || paymentFlow.open || showVoidAuth || showCompletedVoidModal || showDiscountModal || showHistory || showReceiptLookup || showReceiptSettings || showCashFlowModal || showShiftOpen || showShiftClose;

    const actions = {
      focusBarcode: () => {
        barcodeInputRef.current?.focus();
        barcodeInputRef.current?.select?.();
      },
      focusSearch: () => {
        searchProductInputRef.current?.focus();
        searchProductInputRef.current?.select?.();
      },
      focusQuantity: focusLatestQuantityInput,
      newTransaction: handleNewTransaction,
      completeTransaction: handleCompleteTransaction,
      voidTransaction: handleVoidTransaction,
      paymentCash: () => {
        if (isLockedTxn) return;
        updateActiveTransaction({ isSplitPayment: false, paymentMethod: 'cash' });
      },
      paymentGcash: () => {
        if (isLockedTxn) return;
        updateActiveTransaction({ isSplitPayment: false, paymentMethod: 'gcash' });
      },
      requestDiscount: openDiscountModal,
      reprintReceipt: () => handleReprintReceipt(activeTxn),
      receiptLookup: handleOpenReceiptLookup,
      history: handleOpenHistory,
      sync: handleSyncNow,
      settings: () => setShowReceiptSettings(true),
    };

    const handleShortcutKeyDown = (e) => {
      if (e.target?.dataset?.hotkeyCapture === 'true' || modalOpen) return;

      const combo = shortcutFromEvent(e);
      if (!combo) return;

      const editable = isEditableTarget(e.target);
      const functionKey = /^F\d{1,2}$/.test(combo);
      if (editable && !functionKey) return;

      const match = CASHIER_SHORTCUTS.find((item) => shortcutFor(item.action) === combo);
      if (!match || !actions[match.action]) return;

      e.preventDefault();
      actions[match.action]();
    };

    window.addEventListener('keydown', handleShortcutKeyDown);
    return () => window.removeEventListener('keydown', handleShortcutKeyDown);
  });

  const renderApprovalFields = ({
    name,
    method,
    setMethod,
    code,
    setCode,
    email,
    setEmail,
    password,
    setPassword,
    disabled = false,
  }) => (
    <div className={styles['approval-panel']}>
      <div className={styles['approval-methods']} role="radiogroup" aria-label="Approval method">
        <label className={`${styles['approval-option']} ${method === 'barcode' ? styles.active : ''}`}>
          <input
            type="radio"
            name={`approval-${name}`}
            value="barcode"
            checked={method === 'barcode'}
            onChange={() => setMethod('barcode')}
            disabled={disabled}
          />
          Manager barcode
        </label>
        <label className={`${styles['approval-option']} ${method === 'admin' ? styles.active : ''}`}>
          <input
            type="radio"
            name={`approval-${name}`}
            value="admin"
            checked={method === 'admin'}
            onChange={() => setMethod('admin')}
            disabled={disabled}
          />
          Admin password
        </label>
      </div>

      {method === 'barcode' ? (
        <Input
          label="Manager Barcode"
          placeholder="Scan or enter manager barcode"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={disabled}
        />
      ) : (
        <div className={styles['approval-admin-grid']}>
          <Input
            label="Admin Email"
            type="email"
            placeholder="Enter admin email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
          />
          <Input
            label="Admin Password"
            type="password"
            placeholder="Enter admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className={styles['cashier-layout']}>
      <div className={styles['cashier-header']}>
        <div className={styles['header-left']}>
          <h2 className={styles['header-title']}>Cashier POS</h2>
          {user && <span className={styles['cashier-name']}>({user.name || user.email})</span>}
          <Button
            variant="outline"
            size="sm"
            className={styles['history-button']}
            onClick={handleOpenHistory}
          >
            <ClockHistory size={16} />
            {withShortcut('History', 'history')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={styles['history-button']}
            onClick={handleOpenReceiptLookup}
          >
            <Receipt size={16} />
            {withShortcut('Receipt Lookup', 'receiptLookup')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={styles['history-button']}
            onClick={handleSyncNow}
            disabled={syncing}
          >
            <ArrowRepeat size={16} className={syncing ? styles['spin-icon'] : ''} />
            {withShortcut(syncing ? 'Syncing' : 'Sync', 'sync')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={styles['history-button']}
            onClick={() => setShowReceiptSettings(true)}
          >
            <Gear size={16} />
            {withShortcut('Settings', 'settings')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={styles['cash-out-header-button']}
            onClick={() => openCashFlowModal('out')}
          >
            <Dash size={16} />
            Cash Flow
          </Button>
        </div>
        <div className={styles['header-actions']}>
          <button className={styles['logout-button']} onClick={handleLogout}>
            <XLg size={18} />
            Logout
          </button>
        </div>
      </div>

      <div className={styles['transaction-tabs-bar']}>
        <div className={styles['transaction-tabs']}>
          {transactions.map((txn) => (
            <button
              key={txn.id}
              className={`${styles['transaction-tab']} ${activeTransaction === txn.id ? styles.active : ''} ${txn.status === 'completed' ? styles.completed : ''} ${txn.status === 'voided' ? styles.voided : ''}`}
              onClick={() => setActiveTransaction(txn.id)}
              title={txn.transactionNo}
            >
              {txn.name}
              {txn.status === 'completed' ? (
                <small className={styles['tab-done']}>Done</small>
              ) : txn.status === 'voided' ? (
                <small className={`${styles['tab-done']} ${styles.voided}`}>Voided</small>
              ) : txn.cartItems.length > 0 && (
                <small className={styles['tab-count']}>{txn.cartItems.reduce((sum, item) => sum + item.quantity, 0)}</small>
              )}
              <span
                className={styles['tab-close']}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTransaction(txn.id);
                }}
              >
                <XLg size={16} />
              </span>
            </button>
          ))}
        </div>
        <div className={styles['transaction-actions']}>
          <button className={styles['transaction-new']} onClick={handleNewTransaction}>
            <Plus size={14} />
            {withShortcut('New Transaction', 'newTransaction')}
          </button>
        </div>
      </div>

      <div className={styles['cashier-content']}>
        <div className={styles['cashier-left']}>
          <div className={styles['transaction-summary-strip']}>
            <div>
              <span>Transaction No.</span>
              <strong>{activeTxn.transactionNo}</strong>
            </div>
            <div>
              <span>Items</span>
              <strong>{itemCount}</strong>
            </div>
            <div>
              <span>Subtotal</span>
              <strong>{money(subtotal)}</strong>
            </div>
            <div>
              <span>Total</span>
              <strong>{money(total)}</strong>
            </div>
          </div>

          {isLockedTxn && (
            <div className={styles['completed-banner']}>
              <div>
                <strong>{isVoidedTxn ? 'Transaction Voided' : 'Transaction Completed'}</strong>
                <span>
                  {activeTxn.completedSale?.transactionNo || activeTxn.transactionNo}
                  {isVoidedTxn ? ' was voided' : ' was completed'}
                  {activeTxn.completedSale?.voidedAt
                    ? ` at ${formatTransactionTime(activeTxn.completedSale.voidedAt)}`
                    : (activeTxn.completedSale?.completedAt ? ` at ${formatTransactionTime(activeTxn.completedSale.completedAt)}` : '')}.
                </span>
              </div>
              <div className={styles['completed-banner-actions']}>
                <Badge variant={isVoidedTxn ? 'danger' : (activeTxn.completedSale?.pendingSync ? 'info' : 'success')} size="sm">
                  {isVoidedTxn ? 'Voided' : (activeTxn.completedSale?.pendingSync ? 'Pending sync' : 'Completed')}
                </Badge>
                {activeTxn.completedSale?.discounted && (
                  <Badge variant="warning" size="sm">
                    Discounted {activeTxn.completedSale.discountPercent}%
                  </Badge>
                )}
                {isCompletedTxn && !isVoidedTxn && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleOpenCompletedVoidModal({
                      saleId: activeTxn.completedSale?.saleId,
                      transactionNo: activeTxn.completedSale?.transactionNo || activeTxn.transactionNo,
                      totalAmount: activeTxn.completedSale?.totalAmount || total,
                    })}
                  >
                    Void Transaction
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className={styles['add-product-section']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Add Product</h3>
              <span className={styles['transaction-label']}>Transaction No. {activeTxn.transactionNo}</span>
            </div>

            <div className={styles['input-group']}>
              <Input
                label={withShortcut('Scan Barcode', 'focusBarcode')}
                placeholder="Scan or enter barcode"
                inputRef={barcodeInputRef}
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                disabled={isLockedTxn}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleScan();
                  }
                }}
              />
              <Button variant="primary" className={styles['btn-scan']} onClick={handleScan} disabled={isLockedTxn}>Scan</Button>
            </div>

            <Input
              label={withShortcut('Search Product', 'focusSearch')}
              placeholder="Search by product name or barcode"
              inputRef={searchProductInputRef}
              value={searchProduct}
              onChange={handleSearchProductChange}
              onKeyDown={handleSearchKeyDown}
              disabled={isLockedTxn}
            />

            {lastScanned && (
              <div className={styles['last-scanned']}>
                <ProductThumb product={lastScanned} />
                <div>
                  <span>Last Scanned</span>
                  <strong>{lastScanned.name}</strong>
                  <small>{lastScanned.barcode || 'No barcode'} | {money(lastScanned.price)}</small>
                </div>
                <span className={`${styles['stock-pill']} ${styles[stockState({ ...lastScanned, stockQty: stockForProduct(lastScanned) }).key]}`}>
                  {stockState({ ...lastScanned, stockQty: stockForProduct(lastScanned) }).label}
                </span>
              </div>
            )}

            {productsLoading && <div className={styles['search-empty']}>Loading products...</div>}
            {productsError && <div className={styles['search-empty']}>{productsError}</div>}

            {searchProduct && (
              <div className={styles['search-results']}>
                {filteredProducts.length === 0 ? (
                  <div className={styles['search-empty']}>No products found.</div>
                ) : (
                  filteredProducts.map((product, index) => {
                    const stock = stockState({ ...product, qty: stockForProduct(product) });
                    const units = normalizeSellingUnits(product);
                    return (
                      <button
                        key={product.id}
                        className={`${styles['search-result-item']} ${index === selectedSearchIndex ? styles.selected : ''} ${stock.key === 'out' ? styles.disabled : ''}`}
                        onClick={() => handleAddToCart(product)}
                        disabled={stock.key === 'out'}
                      >
                        <div className={styles['product-option-main']}>
                          <ProductThumb product={product} />
                          <div>
                            <div className={styles['product-name']}>{product.name}</div>
                            <div className={styles['product-meta']}>
                              {product.barcode || 'No barcode'} | {product.category} | {units.length > 1 ? `${units.length} units available` : money(product.price)}
                            </div>
                          </div>
                        </div>
                        <span className={`${styles['stock-pill']} ${styles[stock.key]}`}>{stock.label}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div className={styles['cart-section']}>
            <div className={styles['cart-header']}>
              <h3 className={styles['section-title']}>
                Cart
                <Badge variant="info" size="sm">{cartItems.length} Items</Badge>
                <ShortcutHint action="focusQuantity" />
              </h3>
            </div>

            {cartItems.length === 0 ? (
              <div className={styles['empty-cart']}>
                <Cart size={48} style={{ color: '#9ca3af' }} />
                <p>No items in cart</p>
              </div>
            ) : (
              <div className={styles['cart-items']}>
                {cartItems.map((item) => {
                  const remainingStock = stockForProduct(item);
                  const conversion = Number(item.conversion) > 0 ? Number(item.conversion) : 1;
                  const maxQty = Math.max(1, Math.floor(getRemainingStock(item, activeTransaction) / conversion));
                  const stock = stockState({ ...item, stockQty: remainingStock });
                  return (
                    <div key={item.id} className={styles['cart-item']}>
                      <ProductThumb product={item} />
                      <div className={styles['cart-item-content']}>
                        <div className={styles['cart-item-name']}>{item.name}</div>
                        <div className={styles['cart-item-meta']}>
                          {item.unit} @ {money(item.price)}
                          {conversion > 1 ? <span>{conversion} {pluralUnit(products.find((product) => product.id === item.productId)?.unit || 'base unit', conversion)} each</span> : null}
                        </div>
                        <span className={`${styles['stock-pill']} ${styles[stock.key]}`}>{stock.label}</span>
                      </div>
                      <div className={styles['quantity-control']} aria-label={`Quantity for ${item.name}`}>
                        <button
                          type="button"
                          onClick={() => adjustQuantity(item.id, -1)}
                          disabled={item.quantity <= 1}
                          aria-label="Decrease quantity"
                        >
                          <Dash size={14} />
                        </button>
                        <input
                          ref={(node) => {
                            if (node) quantityInputRefs.current.set(item.id, node);
                            else quantityInputRefs.current.delete(item.id);
                          }}
                          type="number"
                          min="1"
                          max={maxQty}
                          value={item.quantity}
                          onChange={(e) => handleQuantityChange(item.id, e.target.value)}
                          onBlur={(e) => handleQuantityChange(item.id, e.target.value || 1)}
                          onWheel={(e) => {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => adjustQuantity(item.id, 1)}
                          disabled={item.quantity >= maxQty}
                          aria-label="Increase quantity"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      <div className={styles['cart-item-total']}>{money(item.total)}</div>
                      <button className={styles['cart-item-remove']} onClick={() => handleRemoveItem(item.id)}>
                        <Trash size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className={styles['cashier-right']}>
          <div className={styles['payment-card']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Payment</h3>
              <div className={styles['register-tools']}>
                <span className={styles['register-status']}>
                  {cashRegisterOpen ? 'Register Open' : 'Register Closed'}
                </span>
              </div>
            </div>

            {isLockedTxn && (
              <div className={styles['payment-complete-card']}>
                <strong>{isVoidedTxn ? 'Voided' : 'Completed'}</strong>
                <span>Transaction {activeTxn.completedSale?.transactionNo || activeTxn.transactionNo}</span>
              </div>
            )}

            <div className={styles['payment-summary']}>
              <div className={styles['summary-row']}><span>Subtotal:</span><span>{money(displaySubtotal)}</span></div>
              <div className={styles['summary-row']}><span>Discount ({displayDiscountPercent}%):</span><span>-{money(displayDiscountAmount)}</span></div>
              <div className={`${styles['summary-row']} ${styles['summary-total']}`}><span>Total:</span><span>{money(displayTotal)}</span></div>
            </div>

            <div className={styles['quick-actions']}>
              <label className={styles['filter-label']}>Quick Actions</label>
              <div className={styles['payment-buttons']}>
                <button
                  type="button"
                  className={styles['payment-btn']}
                  onClick={openDiscountModal}
                  disabled={isLockedTxn}
                >
                  {withShortcut('Discount', 'requestDiscount')}
                </button>
              </div>
            </div>

            <div className={styles['payment-method']}>
              <label className={styles['filter-label']}>Payment Type</label>
              <div className={styles['payment-buttons']}>
                <button className={`${styles['payment-btn']} ${!isSplitPayment ? styles.active : ''}`} onClick={() => updateActiveTransaction({ isSplitPayment: false })} disabled={isLockedTxn}>Single</button>
                <button className={`${styles['payment-btn']} ${isSplitPayment ? styles.active : ''}`} onClick={() => updateActiveTransaction({ isSplitPayment: true })} disabled={isLockedTxn}>Split</button>
              </div>
            </div>

            {!displayIsSplitPayment ? (
              <>
                <div className={styles['payment-method']}>
                  <label className={styles['filter-label']}>Payment Method</label>
                  <div className={styles['payment-buttons']}>
                    <button className={`${styles['payment-btn']} ${displayPaymentMethod === 'cash' ? styles.active : ''}`} onClick={() => updateActiveTransaction({ paymentMethod: 'cash' })} disabled={isLockedTxn}>{withShortcut('Cash', 'paymentCash')}</button>
                    <button className={`${styles['payment-btn']} ${displayPaymentMethod === 'gcash' ? styles.active : ''}`} onClick={() => updateActiveTransaction({ paymentMethod: 'gcash' })} disabled={isLockedTxn}>{withShortcut('GCash', 'paymentGcash')}</button>
                  </div>
                </div>

                {displayPaymentMethod === 'cash' && (
                  isCompletedTxn ? (
                    <div className={styles['change-display']}>
                      <div className={styles['change-row']}><span>Cash Tendered:</span><span>{money(displayCashTendered)}</span></div>
                      <div className={`${styles['change-due']} ${displayChange < 0 ? styles.negative : ''}`}>
                        <span>{displayChange >= 0 ? 'Change Due' : 'Short By'}</span>
                        <strong>{money(Math.abs(displayChange))}</strong>
                      </div>
                    </div>
                  ) : (
                    <div className={styles['cash-modal-hint']}>
                      <span>Total amount</span>
                      <strong>{money(displayTotal)}</strong>
                      <small>Press Complete Transaction to enter the cash amount.</small>
                    </div>
                  )
                )}

                {displayPaymentMethod === 'gcash' && (
                  <>
                    <Input label="GCash Amount" type="number" placeholder="Enter GCash amount" value={displayGcashAmount} onChange={(e) => updateActiveTransaction({ gcashAmount: e.target.value })} disabled={isLockedTxn} />
                    <Input label="GCash Reference Number" placeholder="Enter GCash reference" value={displayGcashRef} onChange={(e) => updateActiveTransaction({ gcashRef: e.target.value })} disabled={isLockedTxn} />
                    <div className={styles['total-display']}><span>Total amount: {money(displayTotal)}</span></div>
                  </>
                )}
              </>
            ) : (
              <div className={styles['payment-method']}>
                <label className={styles['filter-label']}>Split Payment Breakdown</label>
                <Input inputRef={splitCashInputRef} label="Cash Amount" type="number" placeholder="Enter cash amount" value={displaySplitPayments.cash} onChange={(e) => handleSplitPaymentChange('cash', e.target.value)} disabled={isLockedTxn} />
                <Input inputRef={splitGcashInputRef} label="GCash Amount" type="number" placeholder="Enter GCash amount" value={displaySplitPayments.gcash} onChange={(e) => handleSplitPaymentChange('gcash', e.target.value)} disabled={isLockedTxn} />
                <Input label="GCash Reference Number" placeholder="Enter GCash reference" value={displaySplitPayments.gcashRef || ''} onChange={(e) => handleSplitPaymentChange('gcashRef', e.target.value)} disabled={isLockedTxn} />
                <div className={styles['change-display']}>
                  <div className={styles['change-row']}><span>Total Paid:</span><span>{money(displaySplitPaid)}</span></div>
                  <div className={`${styles['change-row']} ${displaySplitRemaining > 0 ? styles.negative : ''}`}><span>Remaining:</span><span>{money(displaySplitRemaining)}</span></div>
                </div>
              </div>
            )}

            <Button
              variant="primary"
              fullWidth
              className={styles['complete-button']}
              onClick={handleCompleteTransaction}
              disabled={cartItems.length === 0 || isLockedTxn}
            >
              {isVoidedTxn ? 'Transaction Voided' : (isCompletedTxn ? 'Transaction Completed' : withShortcut('Complete Transaction', 'completeTransaction'))}
            </Button>

            {isCompletedTxn && !isVoidedTxn && (
              <div className={styles['receipt-print-actions']}>
                <Button
                  variant="outline"
                  fullWidth
                  className={styles['receipt-print-action']}
                  onClick={() => handleReprintReceipt(activeTxn)}
                  disabled={isReceiptPrintBusy(activeTxn)}
                >
                  <Printer size={14} />
                  {withShortcut(receiptButtonText(activeTxn.completedSale), 'reprintReceipt')}
                </Button>
                {receiptSettings.showPdfTestButton && (
                  <Button
                    variant="outline"
                    fullWidth
                    className={styles['receipt-print-action']}
                    onClick={() => handlePrintReceiptPdf(activeTxn)}
                  >
                    <Receipt size={14} />
                    Print PDF Test
                  </Button>
                )}
              </div>
            )}

            {(receiptPrintQueue.length > 0 || printerQueueJobs.length > 0) && (
              <div className={styles['receipt-queue-panel']}>
                <div className={styles['receipt-queue-head']}>
                  <strong>Receipt Print Queue</strong>
                  <button type="button" onClick={refreshPrinterQueue}>Refresh</button>
                </div>
                {receiptPrintQueue.map((job) => (
                  <div className={styles['receipt-queue-row']} key={job.id}>
                    <span>{job.transactionNo}</span>
                    <strong>{job.status}</strong>
                    {job.error && <small>{job.error}</small>}
                  </div>
                ))}
                {printerQueueJobs.map((job) => (
                  <div className={styles['receipt-queue-row']} key={`windows-${job.id}`}>
                    <span>{job.document || `Windows job ${job.id}`}</span>
                    <strong>{job.statusText}</strong>
                  </div>
                ))}
              </div>
            )}

            {!isLockedTxn && cartItems.length > 0 && (
              <div className={styles['void-zone']}>
                <button type="button" onClick={handleVoidTransaction}>
                  <Trash size={14} />
                  {withShortcut('Void this transaction', 'voidTransaction')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        isOpen={paymentFlow.open}
        onClose={paymentFlow.busy ? () => {} : closePaymentFlow}
        title={paymentFlow.method === 'gcash' ? 'Complete GCash Sale' : paymentFlow.method === 'split' ? 'Complete Split Sale' : 'Complete Cash Sale'}
        closeButton={!paymentFlow.busy && paymentFlow.step === 'amount'}
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={closePaymentFlow} disabled={paymentFlow.busy || paymentFlow.step !== 'amount'}>Cancel</button>
            <button className="btn btn-primary" onClick={advancePaymentFlow} disabled={paymentFlow.busy}>
              {paymentFlow.busy
                ? 'Processing...'
                : paymentFlow.step === 'amount'
                  ? 'Complete Sale'
                  : paymentFlow.step === 'change'
                    ? 'Open Register'
                    : 'Print Receipt'}
            </button>
          </div>
        }
      >
        <div
          ref={paymentFlowPanelRef}
          tabIndex={-1}
          className={styles['payment-flow-panel']}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              advancePaymentFlow();
            }
          }}
        >
          <div className={styles['payment-flow-summary']}>
            <div>
              <span>Transaction</span>
              <strong>{paymentFlowTransactionNo}</strong>
            </div>
            <div>
              <span>Total</span>
              <strong>{money(total)}</strong>
            </div>
          </div>

          {paymentFlow.step === 'amount' && paymentFlow.method === 'cash' && (
            <Input
              label="Cash Amount"
              type="number"
              min={total}
              step="0.01"
              placeholder="Enter cash amount"
              inputRef={paymentAmountInputRef}
              value={paymentFlow.amount}
              onChange={(e) => setPaymentFlow((current) => ({ ...current, amount: e.target.value, error: '' }))}
              disabled={paymentFlow.busy}
            />
          )}

          {paymentFlow.step === 'amount' && paymentFlow.method === 'gcash' && (
            <>
              <Input
                label="GCash Amount"
                type="number"
                min={total}
                step="0.01"
                placeholder="Enter GCash amount"
                inputRef={paymentAmountInputRef}
                value={paymentFlow.gcashAmount || ''}
                onChange={(e) => setPaymentFlow((current) => ({ ...current, gcashAmount: e.target.value, error: '' }))}
                disabled={paymentFlow.busy}
              />
              <Input
                label="GCash Reference Number"
                placeholder="Enter GCash reference"
                value={paymentFlow.gcashRef || ''}
                onChange={(e) => setPaymentFlow((current) => ({ ...current, gcashRef: e.target.value, error: '' }))}
                disabled={paymentFlow.busy}
              />
            </>
          )}

          {paymentFlow.step === 'amount' && paymentFlow.method === 'split' && (
            <>
              <Input
                label="Cash Amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="Enter cash amount"
                inputRef={paymentAmountInputRef}
                value={paymentFlow.splitPayments?.cash || ''}
                onChange={(e) => setPaymentFlow((current) => ({
                  ...current,
                  splitPayments: { ...(current.splitPayments || {}), cash: e.target.value },
                  error: '',
                }))}
                disabled={paymentFlow.busy}
              />
              <Input
                label="GCash Amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="Enter GCash amount"
                value={paymentFlow.splitPayments?.gcash || ''}
                onChange={(e) => setPaymentFlow((current) => ({
                  ...current,
                  splitPayments: { ...(current.splitPayments || {}), gcash: e.target.value },
                  error: '',
                }))}
                disabled={paymentFlow.busy}
              />
              <Input
                label="GCash Reference Number"
                placeholder="Enter GCash reference"
                value={paymentFlow.splitPayments?.gcashRef || ''}
                onChange={(e) => setPaymentFlow((current) => ({
                  ...current,
                  splitPayments: { ...(current.splitPayments || {}), gcashRef: e.target.value },
                  error: '',
                }))}
                disabled={paymentFlow.busy}
              />
            </>
          )}

          {paymentFlow.step !== 'amount' && (
            <div className={styles['payment-flow-change']}>
              <span>Change Due</span>
              <strong>{money(paymentFlowChange)}</strong>
              <small>
                {paymentFlow.method === 'gcash'
                  ? `GCash paid: ${money(paymentFlowGcashPaid)}`
                  : paymentFlow.method === 'split'
                    ? `Total paid: ${money(paymentFlowCashPaid + paymentFlowGcashPaid)}`
                  : `Cash tendered: ${money(paymentFlowCashPaid)}`}
              </small>
            </div>
          )}

          {paymentFlow.step === 'change' && (
            <p className={styles['payment-flow-instruction']}>Press Enter to open the cash register.</p>
          )}

          {paymentFlow.step === 'register' && (
            <p className={styles['payment-flow-instruction']}>Close the cash register, then press Enter to print the receipt.</p>
          )}

          {paymentFlow.step === 'receipt' && (
            <p className={styles['payment-flow-instruction']}>Press Enter to print the receipt.</p>
          )}

          {paymentFlow.error && <div className={styles['payment-flow-error']}>{paymentFlow.error}</div>}
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(pendingCartProduct)}
        onClose={closeInitialQuantityPrompt}
        title="Add Quantity"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={closeInitialQuantityPrompt}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmInitialQuantity}>
              Add to Cart
            </button>
          </div>
        }
      >
        {pendingCartProduct && (
          <div className={styles['initial-quantity-panel']}>
            <div className={styles['initial-quantity-product']}>
              <ProductThumb product={pendingCartProduct} />
              <div>
                <strong>{pendingCartProduct.name}</strong>
                <span>{pendingCartSelectedUnit?.barcode || pendingCartProduct.barcode || 'No barcode'} | {money(pendingCartSelectedUnit?.price || pendingCartProduct.price)}</span>
                <small>
                  Available: {pendingCartAvailableQty} {pluralUnit(pendingCartSelectedUnit?.unit || pendingCartProduct.unit || 'item', pendingCartAvailableQty)}
                  {pendingCartConversion > 1 ? ` (${pendingCartConversion} ${pluralUnit(pendingCartProduct.unit || 'base unit', pendingCartConversion)} each)` : ''}
                </small>
              </div>
            </div>
            {pendingCartUnits.length > 1 ? (
              <label className={styles['unit-picker']}>
                <span>Sell As</span>
                <select
                  value={pendingCartUnitKey}
                  onChange={(e) => {
                    setPendingCartUnitKey(e.target.value);
                    setInitialCartQuantity('1');
                    setInitialCartQuantityError('');
                  }}
                >
                  {pendingCartUnits.map((unit) => (
                    <option key={sellingUnitKey(unit)} value={sellingUnitKey(unit)}>
                      {unit.unit} - {money(unit.price)}{Number(unit.conversion) > 1 ? ` / ${unit.conversion} ${pluralUnit(pendingCartProduct.unit || 'base unit', Number(unit.conversion))}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Input
              label={`Quantity (${pluralUnit(pendingCartSelectedUnit?.unit || pendingCartProduct.unit || 'item')})`}
              type="number"
              min="1"
              max={pendingCartAvailableQty}
              step="1"
              inputRef={initialQuantityInputRef}
              value={initialCartQuantity}
              onChange={(e) => {
                setInitialCartQuantity(e.target.value);
                setInitialCartQuantityError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmInitialQuantity();
                }
              }}
              error={initialCartQuantityError}
            />
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showVoidAuth}
        onClose={() => {
          setShowVoidAuth(false);
          setVoidError('');
          setManagerBarcode('');
        }}
        title="Manager Authorization Required"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => {
              setShowVoidAuth(false);
              setVoidError('');
              setManagerBarcode('');
            }}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={confirmVoidTransaction}>Void Transaction</button>
          </div>
        }
      >
        <p>Please scan the manager barcode to confirm the void.</p>
        <Input label="Manager Barcode" placeholder="Enter manager barcode" value={managerBarcode} onChange={(e) => setManagerBarcode(e.target.value)} />
        {voidError && <div style={{ color: '#dc2626', marginTop: 10 }}>{voidError}</div>}
      </Modal>

      <Modal
        isOpen={showDiscountModal}
        onClose={() => {
          setShowDiscountModal(false);
          setDiscountApproved(false);
          setDiscountApprovalMethod('barcode');
          setDiscountApprovalCode('');
          setDiscountApprovalEmail('');
          setDiscountApprovalPassword('');
          setDiscountAmountInput('');
          setDiscountError('');
        }}
        title="Discount Approval"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => {
              setShowDiscountModal(false);
              setDiscountApproved(false);
              setDiscountApprovalMethod('barcode');
              setDiscountApprovalCode('');
              setDiscountApprovalEmail('');
              setDiscountApprovalPassword('');
              setDiscountAmountInput('');
              setDiscountError('');
            }}>
              Cancel
            </button>
            {!discountApproved ? (
              <button className="btn btn-primary" onClick={async () => {
                try {
                  const authorization = approvalPayload({
                    method: discountApprovalMethod,
                    code: discountApprovalCode,
                    email: discountApprovalEmail,
                    password: discountApprovalPassword,
                  });
                  if (!authorization.code && (!authorization.email || !authorization.password)) {
                    setDiscountError(approvalError(discountApprovalMethod));
                    return;
                  }
                  await cashierApi.authorizeVoid(authorization);
                  setDiscountApproved(true);
                  setDiscountError('');
                } catch (err) {
                  setDiscountError(err.message || 'Invalid manager approval code.');
                }
              }}>
                Verify
              </button>
            ) : (
              <button className="btn btn-success" onClick={() => {
                const amount = parseFloat(discountAmountInput);
                if (Number.isNaN(amount) || amount < 0 || amount > 100) {
                  setDiscountError('Enter a valid discount percentage from 0 to 100.');
                  return;
                }
                updateActiveTransaction({ discount: amount });
                setShowDiscountModal(false);
                setDiscountApproved(false);
                setDiscountApprovalMethod('barcode');
                setDiscountApprovalCode('');
                setDiscountApprovalEmail('');
                setDiscountApprovalPassword('');
                setDiscountAmountInput('');
                setDiscountError('');
                showNotification(`Discount applied: ${amount}%`);
              }}>
                Apply Discount
              </button>
            )}
          </div>
        }
      >
        {!discountApproved ? (
          <>
            <p>Select how this discount will be approved.</p>
            {renderApprovalFields({
              name: 'discount',
              method: discountApprovalMethod,
              setMethod: setDiscountApprovalMethod,
              code: discountApprovalCode,
              setCode: setDiscountApprovalCode,
              email: discountApprovalEmail,
              setEmail: setDiscountApprovalEmail,
              password: discountApprovalPassword,
              setPassword: setDiscountApprovalPassword,
            })}
          </>
        ) : (
          <>
            <p>Manager approved. Enter discount percentage to apply.</p>
            <Input label="Discount (%)" type="number" placeholder="Enter discount percent" value={discountAmountInput} onChange={(e) => setDiscountAmountInput(e.target.value)} />
          </>
        )}
        {discountError && <div style={{ color: '#dc2626', marginTop: 10 }}>{discountError}</div>}
      </Modal>

      <Modal
        isOpen={showShiftOpen}
        onClose={() => {}}
        title="Open Shift"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={openShift} disabled={shiftSaving}>
              {shiftSaving ? 'Opening...' : 'Open Shift'}
            </button>
          </div>
        }
      >
        <p>Enter the beginning cash before using the cashier POS.</p>
        <Input
          label="Cash Beginning"
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={shiftOpeningAmount}
          onChange={(e) => setShiftOpeningAmount(e.target.value)}
          disabled={shiftSaving}
        />
        <Input
          label="Note"
          placeholder="Optional opening note"
          value={shiftNote}
          onChange={(e) => setShiftNote(e.target.value)}
          disabled={shiftSaving}
        />
        {shiftError && <div style={{ color: '#dc2626', marginTop: 10 }}>{shiftError}</div>}
      </Modal>

      <Modal
        isOpen={showShiftClose}
        onClose={() => {
          setShowShiftClose(false);
          resetShiftCloseForm();
        }}
        title="Close Shift"
        footer={
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => {
              setShowShiftClose(false);
              resetShiftCloseForm();
            }} disabled={shiftSaving}>Cancel</button>
            <button className="btn btn-primary" onClick={closeShift} disabled={shiftSaving}>
              {shiftSaving ? 'Closing...' : 'Close Shift & Print'}
            </button>
          </div>
        }
      >
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', marginBottom: '10px' }}>Shift Summary</div>
          <div className={styles['audit-summary-grid']}>
            <div><span>Cash Beginning</span><strong>{money(shiftOpeningCash)}</strong></div>
            <div><span>Cash Sales</span><strong>{money(completedCashSales)}</strong></div>
            <div><span>Cash In</span><strong>{money(shiftCashIn)}</strong></div>
            <div><span>Cash Out</span><strong>{money(shiftCashOut)}</strong></div>
            <div><span>Expected Ending</span><strong>{money(expectedShiftCash)}</strong></div>
          </div>
        </div>
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', marginBottom: '10px' }}>Count Method</div>
          <div className={styles['cash-flow-type-row']}>
            <button
              type="button"
              className={shiftCloseCountMode === 'manual' ? styles.active : ''}
              onClick={() => {
                setShiftCloseCountMode('manual');
                setShiftError('');
              }}
              disabled={shiftSaving}
            >
              Manual Total
            </button>
            <button
              type="button"
              className={shiftCloseCountMode === 'denomination' ? styles.active : ''}
              onClick={() => {
                setShiftCloseCountMode('denomination');
                setShiftError('');
              }}
              disabled={shiftSaving}
            >
              Count by Denomination
            </button>
          </div>
        </div>
        <div style={{ marginBottom: '18px' }}>
          {shiftCloseCountMode === 'denomination' ? (
            <>
              <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', marginBottom: '12px' }}>Enter Denomination Counts</div>
              <div className={styles['denomination-grid']}>
              {DENOMINATIONS.map((denomination) => (
                <label key={denomination} className={styles['denomination-row']}>
                  <span>{money(denomination)}</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={shiftCloseDenominations[denomination] || ''}
                    onChange={(e) => updateShiftCloseDenomination(denomination, e.target.value)}
                    disabled={shiftSaving}
                  />
                </label>
              ))}
              </div>
              <div className={styles['audit-entry-message']}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Calculated Closing Amount</div>
                <div style={{ fontSize: '18px', color: '#1e40af', fontWeight: '800' }}>{money(shiftCloseActualCashEnding)}</div>
              </div>
            </>
          ) : (
            <Input
              label="Actual Cash Ending"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={shiftClosingAmount}
              onChange={(e) => setShiftClosingAmount(e.target.value)}
              disabled={shiftSaving}
            />
          )}
        </div>
        <Input
          label="Closing Note"
          placeholder="Optional note for shortage, overage, or correction"
          value={shiftNote}
          onChange={(e) => setShiftNote(e.target.value)}
          disabled={shiftSaving}
        />
        {shiftError && <div style={{ color: '#991b1b', marginTop: 14, padding: '12px 14px', backgroundColor: '#fee2e2', borderRadius: '8px', fontSize: '14px', fontWeight: '600', border: '1px solid #fecaca' }}>{shiftError}</div>}
        <div style={{ marginTop: '18px', paddingTop: '18px', borderTop: '1px solid #e2e8f0' }}>
          <button
            type="button"
            onClick={() => {
              setShowAdminLogout(true);
              setAdminLogoutError('');
              setAdminLogoutApproved(false);
              setAdminLogoutApprovalCode('');
              setAdminLogoutApprovalEmail('');
              setAdminLogoutApprovalPassword('');
            }}
            disabled={shiftSaving}
            style={{
              width: '100%',
              padding: '10px 14px',
              minHeight: '40px',
              borderRadius: '8px',
              border: '1px solid #fca5a5',
              backgroundColor: '#fee2e2',
              color: '#991b1b',
              fontWeight: '600',
              fontSize: '14px',
              cursor: 'pointer',
              opacity: shiftSaving ? 0.6 : 1,
            }}
          >
            Admin Logout
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={showAdminLogout}
        onClose={() => {
          setShowAdminLogout(false);
          setAdminLogoutError('');
          setAdminLogoutApproved(false);
          setAdminLogoutApprovalCode('');
          setAdminLogoutApprovalEmail('');
          setAdminLogoutApprovalPassword('');
        }}
        title="Admin Logout Confirmation"
        footer={
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-outline"
              onClick={() => {
                setShowAdminLogout(false);
                setAdminLogoutError('');
                setAdminLogoutApproved(false);
                setAdminLogoutApprovalCode('');
                setAdminLogoutApprovalEmail('');
                setAdminLogoutApprovalPassword('');
              }}
              disabled={adminLogoutBusy}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={adminLogoutApproved ? confirmAdminLogoutOnly : approveAdminLogout}
              disabled={adminLogoutBusy}
            >
              {adminLogoutBusy ? 'Processing...' : adminLogoutApproved ? 'Confirm Logout' : 'Verify'}
            </button>
          </div>
        }
      >
        {!adminLogoutApproved ? (
          <>
            <p style={{ marginBottom: '16px', color: '#7f1d1d', fontWeight: '600' }}>This logs out the cashier with manager approval. The shift remains open and no cash count is recorded.</p>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', marginBottom: '10px' }}>Approval Method</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', cursor: 'pointer', backgroundColor: adminLogoutApprovalMethod === 'barcode' ? '#f0fdf4' : '#ffffff' }}>
                  <input
                    type="radio"
                    name="adminLogoutMethod"
                    value="barcode"
                    checked={adminLogoutApprovalMethod === 'barcode'}
                    onChange={() => setAdminLogoutApprovalMethod('barcode')}
                  />
                  <span style={{ fontWeight: '600', fontSize: '13px' }}>Manager Barcode</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', cursor: 'pointer', backgroundColor: adminLogoutApprovalMethod === 'admin' ? '#f0fdf4' : '#ffffff' }}>
                  <input
                    type="radio"
                    name="adminLogoutMethod"
                    value="admin"
                    checked={adminLogoutApprovalMethod === 'admin'}
                    onChange={() => setAdminLogoutApprovalMethod('admin')}
                  />
                  <span style={{ fontWeight: '600', fontSize: '13px' }}>Admin Password</span>
                </label>
              </div>
            </div>
            {adminLogoutApprovalMethod === 'barcode' ? (
              <Input
                label="Manager Barcode"
                placeholder="Scan or enter manager barcode"
                value={adminLogoutApprovalCode}
                onChange={(e) => setAdminLogoutApprovalCode(e.target.value)}
                disabled={adminLogoutBusy}
              />
            ) : (
              <>
                <Input
                  label="Admin Email"
                  placeholder="Enter admin email"
                  value={adminLogoutApprovalEmail}
                  onChange={(e) => setAdminLogoutApprovalEmail(e.target.value)}
                  disabled={adminLogoutBusy}
                />
                <Input
                  label="Admin Password"
                  type="password"
                  placeholder="Enter admin password"
                  value={adminLogoutApprovalPassword}
                  onChange={(e) => setAdminLogoutApprovalPassword(e.target.value)}
                  disabled={adminLogoutBusy}
                />
              </>
            )}
            {adminLogoutError && <div style={{ color: '#991b1b', marginTop: 14, padding: '12px 14px', backgroundColor: '#fee2e2', borderRadius: '8px', fontSize: '14px', fontWeight: '600', border: '1px solid #fecaca' }}>{adminLogoutError}</div>}
          </>
        ) : (
          <p style={{ color: '#166534', fontWeight: '600' }}>Admin verified. Click "Confirm Logout" to logout without closing the shift.</p>
        )}
      </Modal>

      <Modal
        isOpen={showCashFlowModal}
        onClose={resetCashFlowModal}
        title="Cash Flow"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={resetCashFlowModal}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmCashFlow}>Approve & Open Register</button>
          </div>
        }
      >
        <p>Cash flow requires manager approval. The cash drawer opens before the cash movement is recorded.</p>
        <div className={styles['cash-flow-summary']}>
          <div>
            <span>Opening Cash</span>
            <strong>{money(shiftOpeningCash)}</strong>
          </div>
          <div>
            <span>Cash Sales</span>
            <strong>{money(completedCashSales)}</strong>
          </div>
          <div>
            <span>Cash In</span>
            <strong>{money(shiftCashIn)}</strong>
          </div>
          <div>
            <span>Cash Out</span>
            <strong>{money(shiftCashOut)}</strong>
          </div>
          <div>
            <span>Net Flow</span>
            <strong>{money(cashFlowNet)}</strong>
          </div>
          <div>
            <span>Expected Cash</span>
            <strong>{money(expectedShiftCash)}</strong>
          </div>
        </div>
        {recentCashCountHistory.length > 0 ? (
          <div className={styles['cash-count-history']}>
            <strong>Recent Cash Counts</strong>
            {recentCashCountHistory.map((entry) => (
              <div key={entry.id}>
                <span>{new Date(entry.countedAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <small>{entry.type === 'shift-close' ? 'Shift Close' : entry.type === 'cash-audit' ? 'Cash Audit' : 'Admin Override'} - Actual {money(entry.actualCash)} - Variance {money(entry.variance)}</small>
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles['cash-flow-type-row']}>
          <button type="button" className={cashFlowType === 'in' ? styles.active : ''} onClick={() => {
            setCashFlowType('in');
            setCashFlowCategory(CASH_FLOW_CATEGORIES.in[0]);
          }}>Cash In</button>
          <button type="button" className={cashFlowType === 'out' ? styles.active : ''} onClick={() => {
            setCashFlowType('out');
            setCashFlowCategory(CASH_FLOW_CATEGORIES.out[0]);
          }}>Cash Out</button>
        </div>
        <Input label="Amount" type="number" placeholder="Enter amount" value={cashFlowAmount} onChange={(e) => setCashFlowAmount(e.target.value)} />
        <label className={styles['cash-flow-field']}>
          <span>Category</span>
          <select value={cashFlowCategory} onChange={(e) => setCashFlowCategory(e.target.value)}>
            {(CASH_FLOW_CATEGORIES[cashFlowType] || CASH_FLOW_CATEGORIES.out).map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </label>
        <Input label="Note" placeholder="Optional detail for audit review" value={cashFlowReason} onChange={(e) => setCashFlowReason(e.target.value)} />
        {renderApprovalFields({
          name: 'cash-flow',
          method: cashFlowApprovalMethod,
          setMethod: setCashFlowApprovalMethod,
          code: cashFlowApprovalCode,
          setCode: setCashFlowApprovalCode,
          email: cashFlowApprovalEmail,
          setEmail: setCashFlowApprovalEmail,
          password: cashFlowApprovalPassword,
          setPassword: setCashFlowApprovalPassword,
        })}
        {cashFlowError && <div style={{ color: '#dc2626', marginTop: 10 }}>{cashFlowError}</div>}
      </Modal>

      <Modal
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        title="Recent Transactions"
        className={styles['history-modal']}
      >
        <div className={styles['history-tools']}>
          <Input
            label="Search Transaction No."
            placeholder="Enter transaction number"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
          />
          <Button variant="outline" onClick={loadTransactionHistory}>Refresh</Button>
        </div>

        {historyLoading && <div className={styles['history-empty']}>Loading recent transactions...</div>}
        {historyError && <div className={styles['history-empty']}>{historyError}</div>}
        {!historyLoading && !historyError && filteredHistoryRecords.length === 0 && (
          <div className={styles['history-empty']}>No transactions found for today.</div>
        )}
        {!historyLoading && !historyError && filteredHistoryRecords.length > 0 && (
          <div className={styles['history-list']}>
            {filteredHistoryRecords.map((sale) => (
              <div key={sale.id} className={styles['history-item']}>
                <div className={styles['history-item-head']}>
                  <div>
                    <strong>TXN {sale.transactionNo}</strong>
                    <span>{formatTransactionTime(sale.createdAt)} | {sale.itemCount} item(s)</span>
                    <span>{sale.cashierName || 'Cashier'}</span>
                  </div>
                  <div className={styles['history-total']}>{money(sale.totalAmount)}</div>
                </div>
                <div className={styles['history-meta']}>
                  <Badge variant="info" size="sm">{sale.paymentMethod || 'payment'}</Badge>
                  <Badge
                    variant={sale.status === 'Voided' ? 'danger' : (sale.status === 'Adjusted' ? 'warning' : 'success')}
                    size="sm"
                  >
                    {sale.status}
                  </Badge>
                  {(Number(sale.discountPercent) > 0 || Number(sale.discountAmount) > 0) && (
                    <Badge variant="warning" size="sm">
                      Discounted {Number(sale.discountPercent) || 0}%
                    </Badge>
                  )}
                </div>
                <div className={styles['history-lines']}>
                  {sale.items.map((item) => (
                    <div key={item.id}>
                      <span>{item.name} x {item.quantity}</span>
                      <span>{money(item.price * item.quantity)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showReceiptLookup}
        onClose={resetReceiptLookupState}
        title="Receipt Lookup"
        className={styles['lookup-modal']}
        footer={(
          <div className={styles['lookup-footer']}>
            <button className="btn btn-outline" onClick={resetReceiptLookupState} disabled={lookupActionLoading}>
              Close
            </button>
            {lookupSale && lookupMode !== 'verify' && (
              <button
                className={`btn ${lookupMode === 'void' ? 'btn-danger' : 'btn-primary'}`}
                onClick={handleLookupApprovalAction}
                disabled={lookupActionLoading || lookupSale.rawStatus === 'voided'}
              >
                {lookupActionLoading
                  ? 'Processing...'
                  : (lookupMode === 'void' ? 'Confirm Void' : `Confirm ${lookupMode === 'exchange' ? 'Exchange' : 'Refund'}`)}
              </button>
            )}
          </div>
        )}
      >
        <div className={styles['lookup-search']}>
          <Input
            label="Scan Barcode or Enter Transaction No."
            placeholder="Example: 202606220001"
            value={lookupQuery}
            onChange={(e) => setLookupQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleReceiptLookup();
              }
            }}
            disabled={lookupLoading}
          />
          <Button variant="primary" onClick={handleReceiptLookup} disabled={lookupLoading}>
            {lookupLoading ? 'Searching...' : 'Search'}
          </Button>
        </div>

        {lookupError && <div className={styles['lookup-error']}>{lookupError}</div>}

        {!lookupSale && !lookupLoading && (
          <div className={styles['history-empty']}>
            Scan the receipt barcode or type the transaction number to verify, reprint, void, refund, or exchange.
          </div>
        )}

        {lookupSale && (
          <div className={styles['lookup-result']}>
            <div className={styles['lookup-summary']}>
              <div>
                <span>Transaction</span>
                <strong>{lookupSale.transactionNo}</strong>
              </div>
              <div>
                <span>Status</span>
                <Badge
                  variant={lookupSale.rawStatus === 'voided' || lookupSale.status === 'Voided'
                    ? 'danger'
                    : (lookupSale.adjustments?.length ? 'warning' : 'success')}
                  size="sm"
                >
                  {lookupSale.status || 'Completed'}
                </Badge>
              </div>
              <div>
                <span>Date</span>
                <strong>{formatTransactionDate(lookupSale.createdAt)}</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{money(lookupSale.totalAmount)}</strong>
              </div>
              <div>
                <span>Cashier</span>
                <strong>{lookupSale.cashierName || 'Cashier'}</strong>
              </div>
              <div>
                <span>Payment</span>
                <strong>{lookupSale.paymentMethod || 'Payment'}</strong>
              </div>
            </div>

            <div className={styles['lookup-actions']}>
              <button
                type="button"
                className={lookupMode === 'verify' ? styles.active : ''}
                onClick={() => {
                  setLookupMode('verify');
                  setLookupError('');
                  resetLookupApproval();
                }}
              >
                Verify
              </button>
              <button type="button" onClick={handleLookupReprint}>
                Reprint
              </button>
              {receiptSettings.showPdfTestButton && (
                <button type="button" onClick={handleLookupPrintPdf}>
                  Print PDF
                </button>
              )}
              <button
                type="button"
                className={lookupMode === 'void' ? styles.active : ''}
                onClick={() => {
                  setLookupMode('void');
                  setLookupError('');
                  resetLookupApproval();
                }}
                disabled={lookupSale.rawStatus === 'voided'}
              >
                Void
              </button>
              <button
                type="button"
                className={lookupMode === 'refund' ? styles.active : ''}
                onClick={() => {
                  setLookupMode('refund');
                  setLookupError('');
                  resetLookupApproval();
                }}
                disabled={lookupSale.rawStatus === 'voided'}
              >
                Refund Items
              </button>
              <button
                type="button"
                className={lookupMode === 'exchange' ? styles.active : ''}
                onClick={() => {
                  setLookupMode('exchange');
                  setLookupError('');
                  resetLookupApproval();
                }}
                disabled={lookupSale.rawStatus === 'voided'}
              >
                Exchange
              </button>
            </div>

            {lookupMode === 'verify' && (
              <div className={styles['lookup-verification']}>
                <strong>
                  {lookupSale.rawStatus === 'voided' || lookupSale.status === 'Voided'
                    ? 'Receipt found, but this transaction is voided.'
                    : 'Valid receipt. Transaction exists in this terminal.'}
                </strong>
                {lookupSale.adjustments?.length > 0 && (
                  <span>
                    This receipt has {lookupSale.adjustments.length} refund/exchange adjustment(s), total adjusted {money(lookupSale.adjustedAmount)}.
                  </span>
                )}
              </div>
            )}

            <div className={styles['lookup-items']}>
              <div className={styles['lookup-items-head']}>
                <span>Item</span>
                <span>Sold</span>
                <span>Available</span>
                <span>Amount</span>
                {(lookupMode === 'refund' || lookupMode === 'exchange') && <span>Return Qty</span>}
              </div>
              {(lookupSale.items || []).map((item) => {
                const productId = String(item.productId || item.id || '');
                const returnedQty = returnedQuantityForItem(lookupSale, productId);
                const soldQty = Number(item.quantity) || 0;
                const availableQty = Math.max(0, soldQty - returnedQty);
                return (
                  <div key={productId || item.name} className={styles['lookup-item-row']}>
                    <span>{item.name}</span>
                    <span>{soldQty}</span>
                    <span>{availableQty}</span>
                    <span>{money(Number(item.price || 0) * soldQty)}</span>
                    {(lookupMode === 'refund' || lookupMode === 'exchange') && (
                      <input
                        type="number"
                        min="0"
                        max={availableQty}
                        value={lookupReturnQty[productId] || ''}
                        onChange={(e) => {
                          const requested = Math.floor(Number(e.target.value) || 0);
                          setLookupReturnQty((current) => ({
                            ...current,
                            [productId]: Math.max(0, Math.min(availableQty, requested)),
                          }));
                        }}
                        disabled={availableQty <= 0}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {(lookupMode === 'void' || lookupMode === 'refund' || lookupMode === 'exchange') && (
              <div className={styles['lookup-approval']}>
                {lookupMode !== 'void' && (
                  <div className={styles['lookup-adjust-total']}>
                    <span>{lookupMode === 'exchange' ? 'Exchange value' : 'Refund amount'}</span>
                    <strong>{money(selectedLookupReturnTotal())}</strong>
                  </div>
                )}
                {renderApprovalFields({
                  name: 'lookup',
                  method: lookupApprovalMethod,
                  setMethod: setLookupApprovalMethod,
                  code: lookupApprovalCode,
                  setCode: setLookupApprovalCode,
                  email: lookupApprovalEmail,
                  setEmail: setLookupApprovalEmail,
                  password: lookupApprovalPassword,
                  setPassword: setLookupApprovalPassword,
                  disabled: lookupActionLoading,
                })}
                <Input
                  label="Reason"
                  placeholder={lookupMode === 'void' ? 'Reason for voiding' : 'Reason for refund/exchange'}
                  value={lookupReason}
                  onChange={(e) => setLookupReason(e.target.value)}
                  disabled={lookupActionLoading}
                />
                {lookupMode === 'exchange' && (
                  <Input
                    label="Exchange Note"
                    placeholder="Example: Replacement item will be sold in a new transaction"
                    value={lookupNote}
                    onChange={(e) => setLookupNote(e.target.value)}
                    disabled={lookupActionLoading}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showReceiptSettings}
        onClose={() => setShowReceiptSettings(false)}
        title="Cashier Settings"
        className={styles['settings-modal']}
        footer={(
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            {settingsTab === 'shortcuts' && (
              <button
                className="btn btn-outline"
                onClick={() => saveShortcutSettings(DEFAULT_SHORTCUT_SETTINGS)}
              >
                Reset Shortcuts
              </button>
            )}
            <button className="btn btn-primary" onClick={() => setShowReceiptSettings(false)}>
              Done
            </button>
          </div>
        )}
      >
        <div className={styles['settings-layout']}>
          <div className={styles['settings-tabs']} role="tablist" aria-label="Cashier settings sections">
            <button
              type="button"
              className={settingsTab === 'appearance' ? styles.active : ''}
              onClick={() => setSettingsTab('appearance')}
              role="tab"
              aria-selected={settingsTab === 'appearance'}
            >
              <strong>Appearance</strong>
              <small>Light or dark</small>
            </button>
            <button
              type="button"
              className={settingsTab === 'shortcuts' ? styles.active : ''}
              onClick={() => setSettingsTab('shortcuts')}
              role="tab"
              aria-selected={settingsTab === 'shortcuts'}
            >
              <strong>Shortcuts</strong>
              <small>Hotkeys and labels</small>
            </button>
            <button
              type="button"
              className={settingsTab === 'receipt' ? styles.active : ''}
              onClick={() => setSettingsTab('receipt')}
              role="tab"
              aria-selected={settingsTab === 'receipt'}
            >
              <strong>Receipt</strong>
              <small>Print and reprint</small>
            </button>
            <button
              type="button"
              className={settingsTab === 'audit' ? styles.active : ''}
              onClick={() => setSettingsTab('audit')}
              role="tab"
              aria-selected={settingsTab === 'audit'}
            >
              <strong>Audit</strong>
              <small>Cash counts</small>
            </button>
            <button
              type="button"
              className={settingsTab === 'spacing' ? styles.active : ''}
              onClick={() => setSettingsTab('spacing')}
              role="tab"
              aria-selected={settingsTab === 'spacing'}
            >
              <strong>Spacing</strong>
              <small>Paper feed</small>
            </button>
          </div>

          <div className={styles['receipt-settings-panel']}>
            {settingsTab === 'appearance' && (
              <div className={styles['settings-section']}>
                <div className={styles['settings-section-head']}>
                  <div>
                    <h4>Appearance</h4>
                    <p>Use dark mode across the cashier and admin screens on this device.</p>
                  </div>
                </div>
                <label className={styles['receipt-settings-toggle']}>
                  <input
                    type="checkbox"
                    checked={theme === THEMES.dark}
                    onChange={(e) => updateTheme(e.target.checked)}
                  />
                  <span>
                    <strong>Dark mode</strong>
                    <small>Applies to the whole POS system on this computer.</small>
                  </span>
                </label>
              </div>
            )}

            {settingsTab === 'shortcuts' && (
              <div className={styles['settings-section']}>
                <div className={styles['settings-section-head']}>
                  <div>
                    <h4>Cashier Shortcuts</h4>
                    <p>Based on the previous POS flow: F1 scan, F2 discount, F3 search, F4 quantity, and F10 pay.</p>
                  </div>
                </div>
                <label className={styles['receipt-settings-toggle']}>
                  <input
                    type="checkbox"
                    checked={shortcutSettings.showLabels}
                    onChange={(e) => saveShortcutSettings({ showLabels: e.target.checked })}
                  />
                  <span>
                    <strong>Show shortcut labels</strong>
                    <small>Shows the assigned hotkeys beside cashier controls.</small>
                  </span>
                </label>
                <div className={styles['shortcut-grid']}>
                  {CASHIER_SHORTCUTS.map((item) => (
                    <label className={styles['shortcut-row']} key={item.action}>
                      <span>
                        <strong>{item.label}</strong>
                        <small>Default: {item.defaultKeys}</small>
                      </span>
                      <input
                        data-hotkey-capture="true"
                        className={styles['shortcut-input']}
                        value={shortcutFor(item.action)}
                        placeholder="No shortcut"
                        readOnly
                        onKeyDown={(e) => {
                          e.preventDefault();
                          if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                            setShortcut(item.action, '');
                            return;
                          }
                          const combo = shortcutFromEvent(e);
                          if (combo) setShortcut(item.action, combo);
                        }}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {settingsTab === 'audit' && (
              <div className={styles['settings-section']}>
                <div className={styles['settings-section-head']}>
                  <div>
                    <h4>Cash Audit</h4>
                    <p>Record opening cash, cash flow, counted cash, expected ending cash, and variance.</p>
                  </div>
                </div>
                <div className={styles['audit-summary-grid']}>
                  <div><span>Cash Sales</span><strong>{money(completedCashSales)}</strong></div>
                  <div><span>Cash In</span><strong>{money(shiftCashIn)}</strong></div>
                  <div><span>Cash Out</span><strong>{money(shiftCashOut)}</strong></div>
                  <div><span>Expected Ending</span><strong>{money(expectedShiftCash)}</strong></div>
                  <div><span>Variance</span><strong className={auditVariance < 0 ? styles.negative : auditVariance > 0 ? styles.positive : ''}>{money(auditVariance)}</strong></div>
                </div>
                <div className={styles['cash-flow-type-row']}>
                  <button
                    type="button"
                    className={auditCountMode === 'manual' ? styles.active : ''}
                    onClick={() => updateCashierAuditEntry('countMode', 'manual')}
                  >
                    Manual Total
                  </button>
                  <button
                    type="button"
                    className={auditCountMode === 'denomination' ? styles.active : ''}
                    onClick={() => updateCashierAuditEntry('countMode', 'denomination')}
                  >
                    Count by Denomination
                  </button>
                </div>
                <div className={styles['audit-entry-grid']}>
                  <Input
                    label="Cash Beginning"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={cashierAuditEntry.cashBeginning}
                    onChange={(e) => updateCashierAuditEntry('cashBeginning', e.target.value)}
                    disabled={cashierAuditSaving}
                  />
                  <Input
                    label="Expected Cash Ending"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={cashierAuditEntry.cashEnding || expectedShiftCash.toFixed(2)}
                    onChange={(e) => updateCashierAuditEntry('cashEnding', e.target.value)}
                    disabled={cashierAuditSaving}
                  />
                  <Input
                    label="Actual Cash Ending"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={auditCountMode === 'denomination'
                      ? auditDenominationTotal.toFixed(2)
                      : (cashierAuditEntry.actualCashEnding || cashierAuditEntry.cashOnHand)}
                    onChange={(e) => {
                      updateCashierAuditEntry('actualCashEnding', e.target.value);
                      updateCashierAuditEntry('cashOnHand', e.target.value);
                    }}
                    disabled={cashierAuditSaving || auditCountMode === 'denomination'}
                  />
                </div>
                {auditCountMode === 'denomination' && (
                  <div className={styles['denomination-grid']}>
                    {DENOMINATIONS.map((denomination) => (
                      <label key={denomination} className={styles['denomination-row']}>
                        <span>{money(denomination)}</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={cashierAuditEntry.denominations?.[denomination] || ''}
                          onChange={(e) => updateAuditDenomination(denomination, e.target.value)}
                          disabled={cashierAuditSaving}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <div className={styles['audit-entry-message']}>
                  Automatic cash count: {money(auditDenominationTotal)}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles['receipt-spacing-tight-button']}
                    onClick={openRegisterForAudit}
                    disabled={cashierAuditSaving}
                  >
                    Open Register
                  </button>
                  <button
                    type="button"
                    className={styles['receipt-spacing-tight-button']}
                    onClick={saveCashierAuditEntry}
                    disabled={cashierAuditSaving}
                  >
                    {cashierAuditSaving ? 'Saving Audit...' : 'Save Audit Entry'}
                  </button>
                </div>
                {cashierAuditMessage && (
                  <div className={styles['audit-entry-message']}>{cashierAuditMessage}</div>
                )}
              </div>
            )}

            {settingsTab === 'receipt' && (
              <div className={styles['settings-section']}>
                <div className={styles['settings-section-head']}>
                  <div>
                    <h4>Receipt Printing</h4>
                    <p>Controls automatic receipt printing and PDF test output.</p>
                  </div>
                </div>
                <label className={styles['receipt-settings-toggle']}>
                  <input
                    type="checkbox"
                    checked={receiptSettings.autoPrint}
                    onChange={(e) => saveReceiptSettings({ autoPrint: e.target.checked })}
                  />
                  <span>
                    <strong>Automatic receipt printing</strong>
                    <small>Prints one receipt automatically after completing a transaction.</small>
                  </span>
                </label>
                <div className={styles['receipt-printer-setting']}>
                  <Input
                    label="Receipt Printer Name"
                    value={receiptSettings.printerName || ''}
                    placeholder={import.meta.env.VITE_RECEIPT_PRINTER_NAME || 'XP-58H'}
                    onChange={(e) => saveReceiptSettings({ printerName: e.target.value })}
                  />
                  <small>
                    Use the exact Windows printer name. Leave blank to use the configured default.
                  </small>
                </div>
                <label className={styles['receipt-settings-toggle']}>
                  <input
                    type="checkbox"
                    checked={receiptSettings.showPdfTestButton}
                    onChange={(e) => saveReceiptSettings({ showPdfTestButton: e.target.checked })}
                  />
                  <span>
                    <strong>Show PDF test button</strong>
                    <small>Shows a test-only button that saves a receipt PDF instead of using the receipt printer.</small>
                  </span>
                </label>
                {receiptSettings.showPdfTestButton && (
                  <div className={styles['receipt-pdf-location']}>
                    <Input
                      label="PDF Test Save Location"
                      value={receiptSettings.receiptPdfDirectory || ''}
                      placeholder="Choose a folder for test PDFs"
                      readOnly
                    />
                    <Button variant="outline" onClick={selectReceiptPdfDirectory}>
                      Browse
                    </Button>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'spacing' && (
              <div className={styles['settings-section']}>
                <div className={styles['settings-section-head']}>
                  <div>
                    <h4>Receipt Spacing</h4>
                    <p>Adjusts extra paper feed before and after each printed receipt on this computer.</p>
                  </div>
                </div>
                <div className={styles['receipt-spacing-grid']}>
                  <div className={styles['receipt-printer-setting']}>
                    <Input
                      label="Before Receipt Feed Lines"
                      type="number"
                      min="0"
                      max="8"
                      step="1"
                      value={receiptSettings.receiptBeforeFeedLines ?? 0}
                      onChange={(e) => {
                        const value = Math.min(8, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                        saveReceiptSettings({ receiptBeforeFeedLines: value });
                      }}
                    />
                    <small>Use 0 if there is blank space before the store name.</small>
                  </div>
                  <div className={styles['receipt-printer-setting']}>
                    <Input
                      label="After Receipt Feed Lines"
                      type="number"
                      min="0"
                      max="8"
                      step="1"
                      value={receiptSettings.receiptAfterFeedLines ?? receiptSettings.receiptFeedLines ?? 0}
                      onChange={(e) => {
                        const value = Math.min(8, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                        saveReceiptSettings({ receiptAfterFeedLines: value });
                      }}
                    />
                    <small>Use 0 if there is blank space after Thank you.</small>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles['receipt-spacing-tight-button']}
                  onClick={() => saveReceiptSettings({
                    receiptBeforeFeedLines: 0,
                    receiptAfterFeedLines: 0,
                    receiptFeedLines: 0,
                  })}
                >
                  Set before and after to tightest
                </button>
              </div>
            )}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCompletedVoidModal}
        onClose={resetCompletedVoidState}
        title="Void Completed Transaction"
        footer={(
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={resetCompletedVoidState} disabled={completedVoidLoading}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleConfirmCompletedVoid} disabled={completedVoidLoading}>
              {completedVoidLoading ? 'Voiding...' : 'Confirm Void'}
            </button>
          </div>
        )}
      >
        <p>
          Void transaction <strong>{completedVoidTarget?.transactionNo || ''}</strong> with manager approval.
        </p>
        {renderApprovalFields({
          name: 'completed-void',
          method: completedVoidApprovalMethod,
          setMethod: setCompletedVoidApprovalMethod,
          code: completedVoidCode,
          setCode: setCompletedVoidCode,
          email: completedVoidEmail,
          setEmail: setCompletedVoidEmail,
          password: completedVoidPassword,
          setPassword: setCompletedVoidPassword,
          disabled: completedVoidLoading,
        })}
        <Input
          label="Reason"
          placeholder="Reason for voiding this sale"
          value={completedVoidReason}
          onChange={(e) => setCompletedVoidReason(e.target.value)}
          disabled={completedVoidLoading}
        />
        {completedVoidError && <div style={{ color: '#dc2626', marginTop: 10 }}>{completedVoidError}</div>}
      </Modal>

      <Modal
        isOpen={idleLocked}
        onClose={() => {}}
        title="Session Locked"
        footer={(
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={unlockIdleSession} disabled={idleUnlocking}>
              {idleUnlocking ? 'Unlocking...' : 'Unlock'}
            </button>
          </div>
        )}
      >
        <p>This cashier session was locked after inactivity. Unlock with the same cashier account.</p>
        <div className={styles['cash-flow-type-row']}>
          <button
            type="button"
            className={idleUnlockMode === 'barcode' ? styles.active : ''}
            onClick={() => {
              setIdleUnlockMode('barcode');
              setIdleUnlockError('');
            }}
          >
            Barcode
          </button>
          <button
            type="button"
            className={idleUnlockMode === 'password' ? styles.active : ''}
            onClick={() => {
              setIdleUnlockMode('password');
              setIdleUnlockError('');
            }}
          >
            Password
          </button>
        </div>
        {idleUnlockMode === 'barcode' ? (
          <Input
            label="Cashier Barcode"
            placeholder="Scan cashier barcode"
            value={idleUnlockBarcode}
            onChange={(e) => setIdleUnlockBarcode(e.target.value)}
            disabled={idleUnlocking}
          />
        ) : (
          <Input
            label={`Password for ${user?.email || 'cashier'}`}
            type="password"
            placeholder="Enter cashier password"
            value={idleUnlockPassword}
            onChange={(e) => setIdleUnlockPassword(e.target.value)}
            disabled={idleUnlocking}
          />
        )}
        {idleUnlockError && <div style={{ color: '#dc2626', marginTop: 10 }}>{idleUnlockError}</div>}
      </Modal>

      <SyncStatusIndicator scope="cashier" />
      {notification && <div className={styles['notification-toast']}>{notification}</div>}
    </div>
  );
};

export default Cashier;
