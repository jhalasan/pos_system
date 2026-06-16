import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRepeat, ClockHistory, Dash, Plus, Trash, XLg, Cart } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router-dom';
import Input from '../../components/common/Input';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import Modal from '../../components/common/Modal';
import SyncStatusIndicator from '../../components/SyncStatusIndicator';
import { cashierApi, money } from '../services/api';
import styles from '../styles/Cashier.module.css';

function stockState(item) {
  const stockQty = Number(item.stockQty ?? item.qty) || 0;
  const lowStock = Number(item.lowStock) || 0;
  if (stockQty <= 0) return { key: 'out', label: 'Out of stock' };
  if (lowStock > 0 && stockQty <= lowStock) return { key: 'low', label: `Low stock: ${stockQty} left` };
  return { key: 'ok', label: `${stockQty} in stock` };
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
    splitPayments: { cash: '', gcash: '' },
    cashAmount: '',
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

const Cashier = ({ onLogout, user }) => {
  const navigate = useNavigate();
  const barcodeInputRef = useRef(null);
  const [transactions, setTransactions] = useState(() => [createTransaction(1)]);
  const [activeTransaction, setActiveTransaction] = useState(1);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [barcode, setBarcode] = useState('');
  const [searchProduct, setSearchProduct] = useState('');
  const [cashRegisterOpen, setCashRegisterOpen] = useState(false);
  const [notification, setNotification] = useState('');
  const [showVoidAuth, setShowVoidAuth] = useState(false);
  const [managerBarcode, setManagerBarcode] = useState('');
  const [voidError, setVoidError] = useState('');
  const [showCompletedVoidModal, setShowCompletedVoidModal] = useState(false);
  const [completedVoidTarget, setCompletedVoidTarget] = useState(null);
  const [completedVoidCode, setCompletedVoidCode] = useState('');
  const [completedVoidEmail, setCompletedVoidEmail] = useState('');
  const [completedVoidPassword, setCompletedVoidPassword] = useState('');
  const [completedVoidReason, setCompletedVoidReason] = useState('');
  const [completedVoidError, setCompletedVoidError] = useState('');
  const [completedVoidLoading, setCompletedVoidLoading] = useState(false);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [discountApprovalCode, setDiscountApprovalCode] = useState('');
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountError, setDiscountError] = useState('');
  const [discountApproved, setDiscountApproved] = useState(false);
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
  const gcashRef = activeTxn.gcashRef;
  const lastScanned = activeTxn.lastScanned;
  const isCompletedTxn = activeTxn.status === 'completed';
  const isVoidedTxn = activeTxn.status === 'voided' || activeTxn.completedSale?.status === 'voided';
  const isLockedTxn = isCompletedTxn || isVoidedTxn;

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;
  const change = paymentMethod === 'cash' ? (parseFloat(cashAmount) || 0) - total : 0;

  const filteredProducts = useMemo(() => {
    const query = searchProduct.trim().toLowerCase();
    if (!query) return [];
    return products.filter((product) =>
      product.name.toLowerCase().includes(query) ||
      String(product.barcode || '').includes(query)
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

  const getReservedQuantity = (productId, excludedTransactionId = null) => {
    return transactions.reduce((sum, txn) => {
      if (txn.id === excludedTransactionId) return sum;
      const item = txn.cartItems.find((cartItem) => cartItem.id === productId || cartItem.productId === productId);
      return sum + (Number(item?.quantity) || 0);
    }, 0);
  };

  const getRemainingStock = (item, excludedTransactionId = null) => {
    const productId = item.id || item.productId;
    const baseQty = Number(item.stockQty ?? item.qty) || 0;
    return Math.max(0, baseQty - getReservedQuantity(productId, excludedTransactionId));
  };

  const stockForProduct = (item, excludedTransactionId = null) => {
    const productId = item.id || item.productId;
    const source = products.find((product) => product.id === productId) || item;
    return getRemainingStock(source, excludedTransactionId);
  };

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProducts();
    loadNextTransactionNumber();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, [activeTransaction]);

  const handleSplitPaymentChange = (method, value) => {
    updateActiveTransaction((txn) => ({
      splitPayments: { ...txn.splitPayments, [method]: value },
    }));
  };

  const getTotalSplitPayment = () => {
    return (parseFloat(splitPayments.cash) || 0) + (parseFloat(splitPayments.gcash) || 0);
  };

  const getRemainingAmount = () => {
    return Math.max(0, total - getTotalSplitPayment());
  };

  const resetPaymentState = () => {
    updateActiveTransaction({
      cashAmount: '',
      gcashRef: '',
      splitPayments: { cash: '', gcash: '' },
      isSplitPayment: false,
    });
  };

  const resetCompletedVoidState = () => {
    setShowCompletedVoidModal(false);
    setCompletedVoidTarget(null);
    setCompletedVoidCode('');
    setCompletedVoidEmail('');
    setCompletedVoidPassword('');
    setCompletedVoidReason('');
    setCompletedVoidError('');
    setCompletedVoidLoading(false);
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

  const handleOpenCashRegister = () => {
    setCashRegisterOpen(true);
    showNotification('Cash register opened successfully.');
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

    const authorization = completedVoidCode.trim()
      ? { code: completedVoidCode.trim() }
      : { email: completedVoidEmail.trim(), password: completedVoidPassword };

    if (!authorization.code && (!authorization.email || !authorization.password)) {
      setCompletedVoidError('Enter a manager barcode or an admin email and password.');
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

  const handleAddToCart = (product) => {
    if (isLockedTxn) {
      showNotification('This transaction is already completed. Start a new transaction to continue selling.');
      return;
    }
    const availableQty = stockForProduct(product);

    if (availableQty <= 0) {
      showNotification(`${product.name} is out of stock.`);
      return;
    }

    const nextCartItems = (() => {
      const existing = cartItems.find((item) => item.id === product.id);
      if (existing) {
        return cartItems.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1, total: item.price * (item.quantity + 1) }
            : item
        );
      }

      return [
        ...cartItems,
        {
          id: product.id,
          productId: product.id,
          name: product.name,
          quantity: 1,
          unit: product.unit,
          price: product.price,
          stockQty: product.qty,
          lowStock: product.lowStock,
          barcode: product.barcode,
          category: product.category,
          total: product.price,
        },
      ];
    })();

    updateActiveTransaction({
      cartItems: nextCartItems,
      lastScanned: {
        name: product.name,
        barcode: product.barcode,
        price: product.price,
        productId: product.id,
        lowStock: product.lowStock,
      },
    });
    setSearchProduct('');
    setBarcode('');
    window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
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
      handleAddToCart(await cashierApi.productByBarcode(code));
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
        const maxQty = Math.max(1, getRemainingStock(item, activeTransaction));
        const nextQty = Math.max(1, Math.min(maxQty, Math.floor(requested)));

        if (requested > maxQty) {
          showNotification(`Only ${maxQty} item(s) available for ${item.name}.`);
        }

        return {
          ...item,
          quantity: nextQty,
          total: item.price * nextQty,
        };
      }),
    });
  };

  const adjustQuantity = (id, delta) => {
    const item = cartItems.find((cartItem) => cartItem.id === id);
    if (!item) return;
    handleQuantityChange(id, item.quantity + delta);
  };

  const validatePayment = () => {
    if (isLockedTxn) {
      alert(isVoidedTxn ? 'This transaction has already been voided.' : 'This transaction is already completed.');
      return false;
    }

    if (cartItems.length === 0) {
      alert('Add items to the cart before completing the transaction.');
      return false;
    }

    if (isSplitPayment) {
      if (getTotalSplitPayment() < total) {
        alert('Split payment total is less than the transaction total.');
        return false;
      }
      return true;
    }

    if (paymentMethod === 'cash') {
      const paid = parseFloat(cashAmount) || 0;
      if (!cashAmount || paid < total) {
        alert('Please enter a cash amount large enough to cover the total.');
        return false;
      }
    }

    if (paymentMethod === 'gcash' && !gcashRef.trim()) {
      alert('Please enter GCash reference number.');
      return false;
    }

    return true;
  };

  const handleCompleteTransaction = async () => {
    if (!validatePayment()) return;

    const completingTransactionId = activeTxn.id;
    const completedTransactionNo = activeTxn.transactionNo;
    const completedPayment = {
      paymentMethod: isSplitPayment ? 'split' : paymentMethod,
      totalAmount: total,
      cashAmount,
      gcashRef,
      splitPayments,
      change,
      completedAt: new Date().toISOString(),
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
        paymentMethod: isSplitPayment ? 'cash' : paymentMethod,
        refNumber: isSplitPayment ? `split:${JSON.stringify(splitPayments)}` : gcashRef,
        items: cartItems.map((item) => ({
          productId: item.productId,
          name: item.name,
          barcode: item.barcode,
          unit: item.unit,
          quantity: item.quantity,
          price: item.price,
        })),
      });

      await loadProducts();
      const result = await cashierApi.nextTransactionNumber();
      const transactionNo = result.transactionNo || nextLocalTransactionNo(completedTransactionNo);
      setNextTransactionNo(transactionNo);
      const newId = Math.max(...transactions.map((t) => t.id), 0) + 1;
      updateTransactionById(completingTransactionId, {
        status: 'completed',
        completedSale: {
          ...completedPayment,
          saleId: sale.id,
          transactionNo: sale.transactionNo || completedTransactionNo,
          pendingSync: sale.pendingSync,
        },
      });
      setTransactions((current) => [...current, createTransaction(newId, transactionNo)]);
      setActiveTransaction(newId);
      setSearchProduct('');
      setBarcode('');
      if (showHistory) loadTransactionHistory();
      showNotification(`Transaction No. ${sale.transactionNo || sale.id} completed successfully.`);
    } catch (err) {
      showNotification(err.message || 'Unable to complete transaction.');
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

  const handleLogout = () => {
    if (onLogout) {
      onLogout();
      navigate('/login');
    }
  };

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
            History
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={styles['history-button']}
            onClick={handleSyncNow}
            disabled={syncing}
          >
            <ArrowRepeat size={16} className={syncing ? styles['spin-icon'] : ''} />
            {syncing ? 'Syncing' : 'Sync'}
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
            New Transaction
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
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Badge variant={isVoidedTxn ? 'danger' : (activeTxn.completedSale?.pendingSync ? 'info' : 'success')} size="sm">
                  {isVoidedTxn ? 'Voided' : (activeTxn.completedSale?.pendingSync ? 'Pending sync' : 'Completed')}
                </Badge>
                {isCompletedTxn && !isVoidedTxn && (
                  <Button
                    variant="outline"
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
                label="Scan Barcode"
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
              label="Search Product"
              placeholder="Search by product name or barcode"
              value={searchProduct}
              onChange={handleSearchProductChange}
              onKeyDown={handleSearchKeyDown}
              disabled={isLockedTxn}
            />

            {lastScanned && (
              <div className={styles['last-scanned']}>
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
                    return (
                      <button
                        key={product.id}
                        className={`${styles['search-result-item']} ${index === selectedSearchIndex ? styles.selected : ''} ${stock.key === 'out' ? styles.disabled : ''}`}
                        onClick={() => handleAddToCart(product)}
                        disabled={stock.key === 'out'}
                      >
                        <div>
                          <div className={styles['product-name']}>{product.name}</div>
                          <div className={styles['product-meta']}>
                            {product.barcode} | {product.category} | {money(product.price)}
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
                  const maxQty = Math.max(1, getRemainingStock(item, activeTransaction));
                  const stock = stockState({ ...item, stockQty: remainingStock });
                  return (
                    <div key={item.id} className={styles['cart-item']}>
                      <div className={styles['cart-item-content']}>
                        <div className={styles['cart-item-name']}>{item.name}</div>
                        <div className={styles['cart-item-meta']}>
                          {item.unit} @ {money(item.price)}
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
                          type="number"
                          min="1"
                          max={maxQty}
                          value={item.quantity}
                          onChange={(e) => handleQuantityChange(item.id, e.target.value)}
                          onBlur={(e) => handleQuantityChange(item.id, e.target.value || 1)}
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
                <Button
                  variant="success"
                  size="sm"
                  className={styles['register-button']}
                  onClick={handleOpenCashRegister}
                >
                  Open Register
                </Button>
              </div>
            </div>

            {isLockedTxn && (
              <div className={styles['payment-complete-card']}>
                <strong>{isVoidedTxn ? 'Voided' : 'Completed'}</strong>
                <span>Transaction {activeTxn.completedSale?.transactionNo || activeTxn.transactionNo}</span>
              </div>
            )}

            <div className={styles['payment-summary']}>
              <div className={styles['summary-row']}><span>Subtotal:</span><span>{money(subtotal)}</span></div>
              <div className={styles['summary-row']}><span>Discount ({discount}%):</span><span>-{money(discountAmount)}</span></div>
              <div className={`${styles['summary-row']} ${styles['summary-total']}`}><span>Total:</span><span>{money(total)}</span></div>
            </div>

            <div className={styles['discount-row']}>
              <span>Need manager approval for a discount?</span>
              <Button variant="outline" onClick={() => {
                setShowDiscountModal(true);
                setDiscountApprovalCode('');
                setDiscountAmountInput('');
                setDiscountError('');
                setDiscountApproved(false);
              }}>
                Request Discount
              </Button>
            </div>

            <div className={styles['payment-method']}>
              <label className={styles['filter-label']}>Payment Type</label>
              <div className={styles['payment-buttons']}>
                <button className={`${styles['payment-btn']} ${!isSplitPayment ? styles.active : ''}`} onClick={() => updateActiveTransaction({ isSplitPayment: false })} disabled={isLockedTxn}>Single</button>
                <button className={`${styles['payment-btn']} ${isSplitPayment ? styles.active : ''}`} onClick={() => updateActiveTransaction({ isSplitPayment: true })} disabled={isLockedTxn}>Split</button>
              </div>
            </div>

            {!isSplitPayment ? (
              <>
                <div className={styles['payment-method']}>
                  <label className={styles['filter-label']}>Payment Method</label>
                  <div className={styles['payment-buttons']}>
                    <button className={`${styles['payment-btn']} ${paymentMethod === 'cash' ? styles.active : ''}`} onClick={() => updateActiveTransaction({ paymentMethod: 'cash' })} disabled={isLockedTxn}>Cash</button>
                    <button className={`${styles['payment-btn']} ${paymentMethod === 'gcash' ? styles.active : ''}`} onClick={() => updateActiveTransaction({ paymentMethod: 'gcash' })} disabled={isLockedTxn}>GCash</button>
                  </div>
                </div>

                {paymentMethod === 'cash' && (
                  <>
                    <Input label="Cash Amount" type="number" placeholder="Enter cash amount" value={cashAmount} onChange={(e) => updateActiveTransaction({ cashAmount: e.target.value })} disabled={isLockedTxn} />
                    {cashAmount && (
                      <div className={styles['change-display']}>
                        <div className={styles['change-row']}><span>Total Payment:</span><span>{money(total)}</span></div>
                        <div className={`${styles['change-due']} ${change < 0 ? styles.negative : ''}`}>
                          <span>{change >= 0 ? 'Change Due' : 'Short By'}</span>
                          <strong>{money(Math.abs(change))}</strong>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {paymentMethod === 'gcash' && (
                  <>
                    <Input label="GCash Reference Number" placeholder="Enter GCash reference" value={gcashRef} onChange={(e) => updateActiveTransaction({ gcashRef: e.target.value })} disabled={isLockedTxn} />
                    <div className={styles['total-display']}><span>Total amount: {money(total)}</span></div>
                  </>
                )}
              </>
            ) : (
              <div className={styles['payment-method']}>
                <label className={styles['filter-label']}>Split Payment Breakdown</label>
                <Input label="Cash Amount" type="number" placeholder="Enter cash amount" value={splitPayments.cash} onChange={(e) => handleSplitPaymentChange('cash', e.target.value)} disabled={isLockedTxn} />
                <Input label="GCash Amount" type="number" placeholder="Enter GCash amount" value={splitPayments.gcash} onChange={(e) => handleSplitPaymentChange('gcash', e.target.value)} disabled={isLockedTxn} />
                <div className={styles['change-display']}>
                  <div className={styles['change-row']}><span>Total Paid:</span><span>{money(getTotalSplitPayment())}</span></div>
                  <div className={`${styles['change-row']} ${getRemainingAmount() > 0 ? styles.negative : ''}`}><span>Remaining:</span><span>{money(getRemainingAmount())}</span></div>
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
              {isVoidedTxn ? 'Transaction Voided' : (isCompletedTxn ? 'Transaction Completed' : 'Complete Transaction')}
            </Button>

            {!isLockedTxn && cartItems.length > 0 && (
              <div className={styles['void-zone']}>
                <button type="button" onClick={handleVoidTransaction}>
                  <Trash size={14} />
                  Void this transaction
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

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
          setDiscountApprovalCode('');
          setDiscountAmountInput('');
          setDiscountError('');
        }}
        title="Discount Approval"
        footer={
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => {
              setShowDiscountModal(false);
              setDiscountApproved(false);
              setDiscountApprovalCode('');
              setDiscountAmountInput('');
              setDiscountError('');
            }}>
              Cancel
            </button>
            {!discountApproved ? (
              <button className="btn btn-primary" onClick={async () => {
                try {
                  await cashierApi.authorizeVoid(discountApprovalCode);
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
                setDiscountApprovalCode('');
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
            <p>Please enter manager approval code to permit discount changes.</p>
            <Input label="Manager Approval Code" placeholder="Enter manager barcode" value={discountApprovalCode} onChange={(e) => setDiscountApprovalCode(e.target.value)} />
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
                  <Badge variant={sale.status === 'Voided' ? 'danger' : 'success'} size="sm">{sale.status}</Badge>
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
        <Input
          label="Manager Barcode"
          placeholder="Scan or enter manager barcode"
          value={completedVoidCode}
          onChange={(e) => setCompletedVoidCode(e.target.value)}
          disabled={completedVoidLoading}
        />
        <p style={{ margin: '4px 0 12px', color: 'var(--text-muted)', fontSize: 13 }}>
          Or use an admin account if the barcode is unavailable.
        </p>
        <Input
          label="Admin Email"
          type="email"
          placeholder="Enter admin email"
          value={completedVoidEmail}
          onChange={(e) => setCompletedVoidEmail(e.target.value)}
          disabled={completedVoidLoading || Boolean(completedVoidCode.trim())}
        />
        <Input
          label="Admin Password"
          type="password"
          placeholder="Enter admin password"
          value={completedVoidPassword}
          onChange={(e) => setCompletedVoidPassword(e.target.value)}
          disabled={completedVoidLoading || Boolean(completedVoidCode.trim())}
        />
        <Input
          label="Reason"
          placeholder="Reason for voiding this sale"
          value={completedVoidReason}
          onChange={(e) => setCompletedVoidReason(e.target.value)}
          disabled={completedVoidLoading}
        />
        {completedVoidError && <div style={{ color: '#dc2626', marginTop: 10 }}>{completedVoidError}</div>}
      </Modal>

      <SyncStatusIndicator scope="cashier" />
      {notification && <div className={styles['notification-toast']}>{notification}</div>}
    </div>
  );
};

export default Cashier;
