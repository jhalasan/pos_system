import React, { useState } from 'react';
import { Plus, Trash, XLg, Cart } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router-dom';
import Input from '../../components/common/Input';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import Modal from '../../components/common/Modal';
import styles from '../styles/Cashier.module.css';

const Cashier = ({ onLogout, user }) => {
  const navigate = useNavigate();
  const [cartItems, setCartItems] = useState([]);

  const [transactions, setTransactions] = useState([
    { id: 1, name: 'Transaction 1' },
  ]);

  const [activeTransaction, setActiveTransaction] = useState(1);
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [isSplitPayment, setIsSplitPayment] = useState(false);
  const [splitPayments, setSplitPayments] = useState({
    cash: '',
    gcash: ''
  });
  const [cashAmount, setCashAmount] = useState('');
  const [gcashRef, setGcashRef] = useState('');
  const [barcode, setBarcode] = useState('');
  const [searchProduct, setSearchProduct] = useState('');
  const [isAddProductModal, setIsAddProductModal] = useState(false);
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

  const validManagerCodes = ['MANAGER123', 'SUPERVISOR456', 'DISCOUNT789'];

  // Mock products for search
  const [mockProducts] = useState([
    { id: 1, name: 'Cigarettes (Marlboro)', barcode: '8901030123456', category: 'Cigarettes', price: 140 },
    { id: 2, name: 'Rice (5kg)', barcode: '8901030123457', category: 'Rice', price: 250 },
    { id: 3, name: 'Coffee (500g)', barcode: '8901030123458', category: 'Coffee', price: 180 },
    { id: 4, name: 'Bread Loaf', barcode: '8901030123459', category: 'Bakery', price: 75 },
    { id: 5, name: 'Mineral Water', barcode: '8901030123460', category: 'Beverages', price: 40 },
  ]);

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;
  const change = paymentMethod === 'cash' ? (parseFloat(cashAmount) || 0) - total : 0;

  const handleSplitPaymentChange = (method, value) => {
    setSplitPayments({ ...splitPayments, [method]: value });
  };

  const getTotalSplitPayment = () => {
    return (parseFloat(splitPayments.cash) || 0) + (parseFloat(splitPayments.gcash) || 0);
  };

  const getRemainingAmount = () => {
    return Math.max(0, total - getTotalSplitPayment());
  };

  const showNotification = (message) => {
    setNotification(message);
    window.setTimeout(() => setNotification(''), 3200);
  };

  const handleVoidTransaction = () => {
    setShowVoidAuth(true);
    setManagerBarcode('');
    setVoidError('');
  };

  const confirmVoidTransaction = () => {
    if (!validManagerCodes.includes(managerBarcode.trim().toUpperCase())) {
      setVoidError('Manager barcode is not valid.');
      return;
    }
    setCartItems([]);
    setCashAmount('');
    setGcashRef('');
    setSplitPayments({ cash: '', gcash: '' });
    setIsSplitPayment(false);
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
      setCartItems(
        cartItems.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1, total: item.price * (item.quantity + 1) }
            : item
        )
      );
    } else {
      setCartItems([
        ...cartItems,
        {
          id: product.id,
          name: product.name,
          quantity: 1,
          unit: 'pack',
          price: product.price,
          total: product.price,
        },
      ]);
    }
    setSearchProduct('');
    setBarcode('');
  };

  const handleRemoveItem = (id) => {
    setCartItems(cartItems.filter((item) => item.id !== id));
  };

  const handleCompleteTransaction = () => {
    if (cartItems.length === 0) {
      alert('Add items to the cart before completing the transaction.');
      return;
    }

    if (isSplitPayment) {
      if (getTotalSplitPayment() < total) {
        alert('Split payment total is less than the transaction total.');
        return;
      }
      showNotification('Transaction completed with split payment!');
    } else if (paymentMethod === 'cash') {
      const paid = parseFloat(cashAmount) || 0;
      if (!cashAmount || paid < total) {
        alert('Please enter a cash amount large enough to cover the total.');
        return;
      }
      showNotification('Transaction completed with cash payment!');
    } else if (paymentMethod === 'gcash') {
      if (!gcashRef.trim()) {
        alert('Please enter GCash reference number.');
        return;
      }
      showNotification('Transaction completed with GCash payment!');
    }

    setCartItems([]);
    setCashAmount('');
    setGcashRef('');
    setSplitPayments({ cash: '', gcash: '' });
    setIsSplitPayment(false);
  };

  const handleNewTransaction = () => {
    const newId = Math.max(...transactions.map(t => t.id), 0) + 1;
    const newTransaction = { id: newId, name: `Transaction ${newId}` };
    setTransactions([...transactions, newTransaction]);
    setActiveTransaction(newId);
    setCartItems([]);
    setCashAmount('');
    setDiscount(0);
  };

  const handleDeleteTransaction = (txnId) => {
    const remaining = transactions.filter(t => t.id !== txnId);
    setTransactions(remaining);
    if (activeTransaction === txnId && remaining.length > 0) {
      setActiveTransaction(remaining[0].id);
    }
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
      {/* Header */}
      <div className={styles['cashier-header']}>
        <div className={styles['header-left']}>
          <h2 className={styles['header-title']}>Cashier POS</h2>
          {user && <span className={styles['cashier-name']}>({user.username})</span>}
        </div>
        <button
          className={styles['logout-button']}
          onClick={handleLogout}
        >
          <XLg size={18} />
          Logout
        </button>
      </div>

      {/* Transaction Tabs */}
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

      {/* Main Content */}
      <div className={styles['cashier-content']}>
        {/* Left Panel - Cart */}
        <div className={styles['cashier-left']}>
          {/* Add Product */}
          <div className={styles['add-product-section']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Add Product</h3>
              <span className={styles['transaction-label']}>Transaction #{activeTransaction}</span>
            </div>

            {/* Barcode */}
            <div className={styles['input-group']}>
              <Input
                label="Scan Barcode"
                placeholder="Scan or enter barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
              />
              <Button variant="primary" className={styles['btn-scan']}>Scan</Button>
            </div>

            {/* Search */}
            <Input
              label="Search Product"
              placeholder="Search by product name or barcode"
              value={searchProduct}
              onChange={(e) => setSearchProduct(e.target.value)}
            />

            {/* Sample Items */}
            <div className={styles['sample-items']}>
              <div className={styles['sample-items-title']}>Sample Items</div>
              <div className={styles['sample-items-grid']}>
                {mockProducts.slice(0, 4).map((product) => (
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

            {/* Search Results */}
            {searchProduct && (
              <div className={styles['search-results']}>
                {mockProducts
                  .filter((p) =>
                    p.name.toLowerCase().includes(searchProduct.toLowerCase()) ||
                    p.barcode.includes(searchProduct)
                  )
                  .map((product) => (
                    <button
                      key={product.id}
                      className={styles['search-result-item']}
                      onClick={() => handleAddToCart(product)}
                    >
                      <div>
                        <div className={styles['product-name']}>{product.name}</div>
                        <div className={styles['product-meta']}>
                          {product.barcode} • {product.category}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Cart */}
          <div className={styles['cart-section']}>
            <div className={styles['cart-header']}>
              <h3 className={styles['section-title']}>
                Cart
                <Badge variant="info" size="sm">
                  {cartItems.length} Items
                </Badge>
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
                        {item.quantity} × {item.unit} @ ₱{item.price.toLocaleString()}
                      </div>
                    </div>
                    <div className={styles['cart-item-total']}>₱{item.total.toLocaleString()}</div>
                    <button
                      className={styles['cart-item-remove']}
                      onClick={() => handleRemoveItem(item.id)}
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Payment */}
        <div className={styles['cashier-right']}>
          <div className={styles['payment-card']}>
            <div className={styles['section-title-row']}>
              <h3 className={styles['section-title']}>Payment</h3>
              <span className={styles['register-status']}>
                {cashRegisterOpen ? 'Register Open' : 'Register Closed'}
              </span>
            </div>

            {/* Summary */}
            <div className={styles['payment-summary']}>
              <div className={styles['summary-row']}>
                <span>Subtotal:</span>
                <span>₱{subtotal.toLocaleString()}</span>
              </div>
              <div className={styles['summary-row']}>
                <span>Discount ({discount}%):</span>
                <span>-₱{discountAmount.toLocaleString()}</span>
              </div>
              <div className={`${styles['summary-row']} ${styles['summary-total']}`}>
                <span>Total:</span>
                <span>₱{total.toLocaleString()}</span>
              </div>
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

            {/* Payment Method */}
            <div className={styles['payment-method']}>
              <label className={styles['filter-label']}>Payment Type</label>
              <div className={styles['payment-buttons']}>
                <button
                  className={`${styles['payment-btn']} ${!isSplitPayment ? styles.active : ''}`}
                  onClick={() => setIsSplitPayment(false)}
                >
                  Single
                </button>
                <button
                  className={`${styles['payment-btn']} ${isSplitPayment ? styles.active : ''}`}
                  onClick={() => setIsSplitPayment(true)}
                >
                  Split
                </button>
              </div>
            </div>

            {!isSplitPayment ? (
              <>
                {/* Single Payment Method */}
                <div className={styles['payment-method']}>
                  <label className={styles['filter-label']}>Payment Method</label>
                  <div className={styles['payment-buttons']}>
                    <button
                      className={`${styles['payment-btn']} ${paymentMethod === 'cash' ? styles.active : ''}`}
                      onClick={() => setPaymentMethod('cash')}
                    >
                      Cash
                    </button>
                    <button
                      className={`${styles['payment-btn']} ${paymentMethod === 'gcash' ? styles.active : ''}`}
                      onClick={() => setPaymentMethod('gcash')}
                    >
                      GCash
                    </button>
                  </div>
                </div>

                {/* Payment Input */}
                {paymentMethod === 'cash' && (
                  <>
                    <Input
                      label="Cash Amount"
                      type="number"
                      placeholder="Enter cash amount"
                      value={cashAmount}
                      onChange={(e) => setCashAmount(e.target.value)}
                    />
                    {cashAmount && (
                      <div className={styles['change-display']}>
                        <div className={styles['change-row']}>
                          <span>Total Payment:</span>
                          <span>₱{total.toLocaleString()}</span>
                        </div>
                        <div className={styles['change-row']}>
                          <span>Change:</span>
                          <span style={{ color: change >= 0 ? '#16a34a' : '#dc2626', fontWeight: '600' }}>₱{change.toLocaleString()}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {paymentMethod === 'gcash' && (
                  <>
                    <Input
                      label="GCash Reference Number"
                      placeholder="Enter GCash reference"
                      value={gcashRef}
                      onChange={(e) => setGcashRef(e.target.value)}
                    />
                    <div className={styles['total-display']}>
                      <span>Total amount: ₱{total.toLocaleString()}</span>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Split Payment */}
                <div className={styles['payment-method']}>
                  <label className={styles['filter-label']}>Split Payment Breakdown</label>
                  <Input
                    label="Cash Amount"
                    type="number"
                    placeholder="Enter cash amount"
                    value={splitPayments.cash}
                    onChange={(e) => handleSplitPaymentChange('cash', e.target.value)}
                  />
                  <Input
                    label="GCash Amount"
                    type="number"
                    placeholder="Enter GCash amount"
                    value={splitPayments.gcash}
                    onChange={(e) => handleSplitPaymentChange('gcash', e.target.value)}
                  />
                  <div className={styles['change-display']}>
                    <div className={styles['change-row']}>
                      <span>Total Paid:</span>
                      <span>₱{getTotalSplitPayment().toLocaleString()}</span>
                    </div>
                    <div className={`${styles['change-row']} ${getRemainingAmount() > 0 ? styles.negative : ''}`}>
                      <span>Remaining:</span>
                      <span>₱{getRemainingAmount().toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            <div className={styles['action-row']}>
              <Button
                variant="danger"
                fullWidth
                onClick={handleVoidTransaction}
              >
                Void Transaction
              </Button>
              <Button
                variant="success"
                fullWidth
                onClick={handleOpenCashRegister}
              >
                Open Cash Register
              </Button>
            </div>

            {/* Complete Button */}
            <Button
              variant="primary"
              fullWidth
              onClick={handleCompleteTransaction}
              disabled={cartItems.length === 0}
            >
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
            <button className="btn btn-danger" onClick={confirmVoidTransaction}>
              Void Transaction
            </button>
          </div>
        }
      >
        <p>Please scan the manager barcode to confirm the void.</p>
        <Input
          label="Manager Barcode"
          placeholder="Enter manager barcode"
          value={managerBarcode}
          onChange={(e) => setManagerBarcode(e.target.value)}
        />
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
              <button className="btn btn-primary" onClick={() => {
                if (discountApprovalCode.trim().toUpperCase() !== 'MANAGER123') {
                  setDiscountError('Invalid manager approval code.');
                  return;
                }
                setDiscountApproved(true);
                setDiscountError('');
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
            <Input
              label="Manager Approval Code"
              placeholder="Enter manager barcode"
              value={discountApprovalCode}
              onChange={(e) => setDiscountApprovalCode(e.target.value)}
            />
          </>
        ) : (
          <>
            <p>Manager approved. Enter discount percentage to apply.</p>
            <Input
              label="Discount (%)"
              type="number"
              placeholder="Enter discount percent"
              value={discountAmountInput}
              onChange={(e) => setDiscountAmountInput(e.target.value)}
            />
          </>
        )}
        {discountError && <div style={{ color: '#dc2626', marginTop: 10 }}>{discountError}</div>}
      </Modal>

      {notification && (
        <div className={styles['notification-toast']}>
          {notification}
        </div>
      )}
    </div>
  );
};

export default Cashier;
