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
    gcash: '',
    card: '',
  });
  const [cashAmount, setCashAmount] = useState('');
  const [barcode, setBarcode] = useState('');
  const [searchProduct, setSearchProduct] = useState('');
  const [isAddProductModal, setIsAddProductModal] = useState(false);

  // Mock products for search
  const [mockProducts] = useState([
    { id: 1, name: 'Cigarettes (Marlboro)', barcode: '8901030123456', category: 'Cigarettes', price: 140 },
    { id: 2, name: 'Rice (5kg)', barcode: '8901030123457', category: 'Rice', price: 250 },
    { id: 3, name: 'Coffee (500g)', barcode: '8901030123458', category: 'Coffee', price: 180 },
  ]);

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const discountAmount = (subtotal * discount) / 100;
  const total = subtotal - discountAmount;
  const change = paymentMethod === 'cash' ? (parseFloat(cashAmount) || 0) - total : 0;

  const handleSplitPaymentChange = (method, value) => {
    setSplitPayments({ ...splitPayments, [method]: value });
  };

  const getTotalSplitPayment = () => {
    return (parseFloat(splitPayments.cash) || 0) + (parseFloat(splitPayments.gcash) || 0) + (parseFloat(splitPayments.card) || 0);
  };

  const getRemainingAmount = () => {
    return Math.max(0, total - getTotalSplitPayment());
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
    if (isSplitPayment) {
      if (getTotalSplitPayment() < total) {
        alert('Split payment total is less than the transaction total!');
        return;
      }
      alert('Transaction completed with split payment!');
    } else {
      alert('Transaction completed!');
    }
    setCartItems([]);
    setCashAmount('');
    setSplitPayments({ cash: '', gcash: '', card: '' });
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
            <h3 className={styles['section-title']}>Add Product</h3>

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
            <h3 className={styles['section-title']}>Payment</h3>

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
                    <button
                      className={`${styles['payment-btn']} ${paymentMethod === 'card' ? styles.active : ''}`}
                      onClick={() => setPaymentMethod('card')}
                    >
                      Card
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
                      placeholder="Enter reference number"
                    />
                    <div className={styles['total-display']}>
                      <span>Total amount: ₱{total.toLocaleString()}</span>
                    </div>
                  </>
                )}

                {paymentMethod === 'card' && (
                  <>
                    <Input
                      label="Card Reference Number"
                      placeholder="Enter card reference number"
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
                  <Input
                    label="Card Amount"
                    type="number"
                    placeholder="Enter card amount"
                    value={splitPayments.card}
                    onChange={(e) => handleSplitPaymentChange('card', e.target.value)}
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
    </div>
  );
};

export default Cashier;
