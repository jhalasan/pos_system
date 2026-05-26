import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash, XLg, Cart } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router-dom';
import Input from '../../components/common/Input';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import Modal from '../../components/common/Modal';
import { cashierApi, money } from '../services/api';
import styles from '../styles/Cashier.module.css';

const firstTransaction = { id: 1, name: 'Transaction 1' };

const Cashier = ({ onLogout, user }) => {
  const navigate = useNavigate();
  const [cartItems, setCartItems] = useState([]);
  const [transactions, setTransactions] = useState([firstTransaction]);
  const [activeTransaction, setActiveTransaction] = useState(1);
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [isSplitPayment, setIsSplitPayment] = useState(false);
  const [splitPayments, setSplitPayments] = useState({ cash: '', gcash: '' });
  const [cashAmount, setCashAmount] = useState('');
  const [gcashRef, setGcashRef] = useState('');
  const [barcode, setBarcode] = useState('');
  const [searchProduct, setSearchProduct] = useState('');
  const [cashRegisterOpen, setCashRegisterOpen] = useState(false);
  const [notification, setNotification] = useState('');
  const [showVoidAuth, setShowVoidAuth] = useState(false);
  const [managerBarcode, setManagerBarcode] = useState('');
  const [voidError, setVoidError] = useState('');
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [discountApprovalCode, setDiscountApprovalCode] = useState('');
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountError, setDiscountError] = useState('');
  const [discountApproved, setDiscountApproved] = useState(false);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProducts();
  }, []);

  const showNotification = (message) => {
    setNotification(message);
    window.setTimeout(() => setNotification(''), 3200);
  };

  const handleSplitPaymentChange = (method, value) => {
    setSplitPayments({ ...splitPayments, [method]: value });
  };

  const getTotalSplitPayment = () => {
    return (parseFloat(splitPayments.cash) || 0) + (parseFloat(splitPayments.gcash) || 0);
  };

  const getRemainingAmount = () => {
    return Math.max(0, total - getTotalSplitPayment());
  };

  const resetPaymentState = () => {
    setCashAmount('');
    setGcashRef('');
    setSplitPayments({ cash: '', gcash: '' });
    setIsSplitPayment(false);
  };

  const handleVoidTransaction = () => {
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

    setCartItems([]);
    resetPaymentState();
    setShowVoidAuth(false);
    setManagerBarcode('');
    setVoidError('');
    showNotification('Transaction has been voided.');
  };

  const handleOpenCashRegister = () => {
    setCashRegisterOpen(true);
    showNotification('Cash register opened successfully.');
  };

  const handleAddToCart = (product) => {
    const existing = cartItems.find((item) => item.id === product.id);
    if (existing) {
      if (existing.quantity + 1 > product.qty) {
        showNotification(`Only ${product.qty} item(s) available for ${product.name}.`);
        return;
      }
      setCartItems(cartItems.map((item) =>
        item.id === product.id
          ? { ...item, quantity: item.quantity + 1, total: item.price * (item.quantity + 1) }
          : item
      ));
    } else {
      setCartItems([
        ...cartItems,
        {
          id: product.id,
          productId: product.id,
          name: product.name,
          quantity: 1,
          unit: product.unit,
          price: product.price,
          total: product.price,
        },
      ]);
    }
    setSearchProduct('');
    setBarcode('');
  };

  const handleScan = async () => {
    const code = barcode.trim();
    if (!code) return;

    try {
      handleAddToCart(await cashierApi.productByBarcode(code));
    } catch (err) {
      showNotification(err.message || 'Product not found.');
    }
  };

  const handleRemoveItem = (id) => {
    setCartItems(cartItems.filter((item) => item.id !== id));
  };

  const validatePayment = () => {
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

    try {
      const sale = await cashierApi.completeSale({
        cashierId: user?.id,
        totalAmount: total,
        paymentMethod: isSplitPayment ? 'cash' : paymentMethod,
        refNumber: isSplitPayment ? `split:${JSON.stringify(splitPayments)}` : gcashRef,
        items: cartItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
        })),
      });

      await loadProducts();
      setCartItems([]);
      resetPaymentState();
      showNotification(`Transaction #${sale.transactionNo || sale.id} completed successfully.`);
    } catch (err) {
      showNotification(err.message || 'Unable to complete transaction.');
    }
  };

  const handleNewTransaction = () => {
    const newId = Math.max(...transactions.map((t) => t.id), 0) + 1;
    setTransactions([...transactions, { id: newId, name: `Transaction ${newId}` }]);
    setActiveTransaction(newId);
    setCartItems([]);
    setCashAmount('');
    setDiscount(0);
  };

  const handleDeleteTransaction = (txnId) => {
    const remaining = transactions.filter((t) => t.id !== txnId);
    setTransactions(remaining);
    if (activeTransaction === txnId && remaining.length > 0) setActiveTransaction(remaining[0].id);
    if (remaining.length === 0) {
      setCartItems([]);
      setCashAmount('');
      setDiscount(0);
    }
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
        </div>
        <button className={styles['logout-button']} onClick={handleLogout}>
          <XLg size={18} />
          Logout
        </button>
      </div>

      <div className={styles['transaction-tabs-bar']}>
        <div className={styles['transaction-tabs']}>
          {transactions.map((txn) => (
            <button
              key={txn.id}
              className={`${styles['transaction-tab']} ${activeTransaction === txn.id ? styles.active : ''}`}
              onClick={() => setActiveTransaction(txn.id)}
            >
              {txn.name}
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
          <button className={styles['transaction-new']} onClick={handleNewTransaction}>
            <Plus size={14} />
            New Transaction
          </button>
        </div>
      </div>

      <div className={styles['cashier-content']}>
        <div className={styles['cashier-left']}>
          <div className={styles['add-product-section']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Add Product</h3>
              <span className={styles['transaction-label']}>Transaction #{activeTransaction}</span>
            </div>

            <div className={styles['input-group']}>
              <Input
                label="Scan Barcode"
                placeholder="Scan or enter barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleScan();
                  }
                }}
              />
              <Button variant="primary" className={styles['btn-scan']} onClick={handleScan}>Scan</Button>
            </div>

            <Input
              label="Search Product"
              placeholder="Search by product name or barcode"
              value={searchProduct}
              onChange={(e) => setSearchProduct(e.target.value)}
            />

            <div className={styles['sample-items']}>
              <div className={styles['sample-items-title']}>
                {productsLoading ? 'Loading Items' : productsError || 'Available Items'}
              </div>
              <div className={styles['sample-items-grid']}>
                {products.slice(0, 8).map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className={styles['sample-item-button']}
                    onClick={() => handleAddToCart(product)}
                  >
                    {product.name}
                  </button>
                ))}
              </div>
            </div>

            {searchProduct && (
              <div className={styles['search-results']}>
                {filteredProducts.map((product) => (
                  <button
                    key={product.id}
                    className={styles['search-result-item']}
                    onClick={() => handleAddToCart(product)}
                  >
                    <div>
                      <div className={styles['product-name']}>{product.name}</div>
                      <div className={styles['product-meta']}>
                        {product.barcode} | {product.category} | {money(product.price)} | {product.qty} left
                      </div>
                    </div>
                  </button>
                ))}
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
                {cartItems.map((item) => (
                  <div key={item.id} className={styles['cart-item']}>
                    <div className={styles['cart-item-content']}>
                      <div className={styles['cart-item-name']}>{item.name}</div>
                      <div className={styles['cart-item-meta']}>
                        {item.quantity} x {item.unit} @ {money(item.price)}
                      </div>
                    </div>
                    <div className={styles['cart-item-total']}>{money(item.total)}</div>
                    <button className={styles['cart-item-remove']} onClick={() => handleRemoveItem(item.id)}>
                      <Trash size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles['cashier-right']}>
          <div className={styles['payment-card']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Payment</h3>
              <span className={styles['register-status']}>
                {cashRegisterOpen ? 'Register Open' : 'Register Closed'}
              </span>
            </div>

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
                <button className={`${styles['payment-btn']} ${!isSplitPayment ? styles.active : ''}`} onClick={() => setIsSplitPayment(false)}>Single</button>
                <button className={`${styles['payment-btn']} ${isSplitPayment ? styles.active : ''}`} onClick={() => setIsSplitPayment(true)}>Split</button>
              </div>
            </div>

            {!isSplitPayment ? (
              <>
                <div className={styles['payment-method']}>
                  <label className={styles['filter-label']}>Payment Method</label>
                  <div className={styles['payment-buttons']}>
                    <button className={`${styles['payment-btn']} ${paymentMethod === 'cash' ? styles.active : ''}`} onClick={() => setPaymentMethod('cash')}>Cash</button>
                    <button className={`${styles['payment-btn']} ${paymentMethod === 'gcash' ? styles.active : ''}`} onClick={() => setPaymentMethod('gcash')}>GCash</button>
                  </div>
                </div>

                {paymentMethod === 'cash' && (
                  <>
                    <Input label="Cash Amount" type="number" placeholder="Enter cash amount" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} />
                    {cashAmount && (
                      <div className={styles['change-display']}>
                        <div className={styles['change-row']}><span>Total Payment:</span><span>{money(total)}</span></div>
                        <div className={styles['change-row']}>
                          <span>Change:</span>
                          <span style={{ color: change >= 0 ? '#16a34a' : '#dc2626', fontWeight: '600' }}>{money(change)}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {paymentMethod === 'gcash' && (
                  <>
                    <Input label="GCash Reference Number" placeholder="Enter GCash reference" value={gcashRef} onChange={(e) => setGcashRef(e.target.value)} />
                    <div className={styles['total-display']}><span>Total amount: {money(total)}</span></div>
                  </>
                )}
              </>
            ) : (
              <div className={styles['payment-method']}>
                <label className={styles['filter-label']}>Split Payment Breakdown</label>
                <Input label="Cash Amount" type="number" placeholder="Enter cash amount" value={splitPayments.cash} onChange={(e) => handleSplitPaymentChange('cash', e.target.value)} />
                <Input label="GCash Amount" type="number" placeholder="Enter GCash amount" value={splitPayments.gcash} onChange={(e) => handleSplitPaymentChange('gcash', e.target.value)} />
                <div className={styles['change-display']}>
                  <div className={styles['change-row']}><span>Total Paid:</span><span>{money(getTotalSplitPayment())}</span></div>
                  <div className={`${styles['change-row']} ${getRemainingAmount() > 0 ? styles.negative : ''}`}><span>Remaining:</span><span>{money(getRemainingAmount())}</span></div>
                </div>
              </div>
            )}

            <div className={styles['action-row']}>
              <Button variant="danger" fullWidth onClick={handleVoidTransaction}>Void Transaction</Button>
              <Button variant="success" fullWidth onClick={handleOpenCashRegister}>Open Cash Register</Button>
            </div>

            <Button variant="primary" fullWidth onClick={handleCompleteTransaction} disabled={cartItems.length === 0}>
              Complete Transaction
            </Button>
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
                setDiscount(amount);
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

      {notification && <div className={styles['notification-toast']}>{notification}</div>}
    </div>
  );
};

export default Cashier;
