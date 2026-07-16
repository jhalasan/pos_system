# NEXA POS System

## Modules and Features Inventory

### List of Modules

1. Role Selection and Authentication
2. Admin Dashboard
3. Inventory Management
4. Product Management
5. Barcode Tools
6. Staff Management
7. Sales Analytics
8. Transaction Logs
9. Audit and Cash Reconciliation
10. Activity Logs
11. Admin Settings
12. Data Administration
13. Offline Synchronization
14. Cashier POS
15. Payment Processing
16. Receipt Management
17. Returns, Exchanges, and Voids
18. Cash Flow and Shift Management

## List of Features

### 1. Role Selection and Authentication

- Admin and cashier workspace selection
- Admin email/password login and quick-login profiles
- Cashier email/password and barcode login
- Cached offline cashier login
- Active/inactive account enforcement
- Caps Lock detection, session locking, and logout
- Manager authorization using barcode or credentials

### 2. Admin Dashboard

- Today's sales, transaction count, average sale, and payment totals
- Critical-stock, low-stock, and out-of-stock monitoring
- Inventory health overview and synchronization warnings
- Recent transactions, top products, and top categories
- Seven-day sales trend
- Data-source and date filters
- Quick links to related modules

### 3. Inventory Management

- Barcode-based stock-in and stock-out scanning
- Product search, unit selection, and base-unit conversion
- Batch review and instant stock updates
- Stock-out reasons for damaged, expired, and other removed goods
- Physical stock reconciliation
- System quantity versus physical-count comparison
- Automatic variance calculation
- Adjustment reasons, notes, and manager approval
- Offline stock-operation queueing

### 4. Product Management

- Add, edit, archive, and delete products
- Product image upload
- Category creation and assignment
- Barcode, cost, price, margin, stock, and low-stock settings
- Base, purchase, and multiple selling units
- Unit-specific prices and barcodes
- Product search, filtering, sorting, and paginated loading
- Inventory catalog export and printing
- Detection of missing or duplicate barcodes, uncategorized products, invalid prices, and negative inventory

### 5. Barcode Tools

- Standalone product barcode generation and preview
- Barcode label printing and PDF/image saving
- Printer and copy-count configuration
- Batch barcode selection and printing
- Authorization barcode generation, renaming, printing, and deletion
- Staff ID barcode generation and printing

### 6. Staff Management

- Add, edit, remove, activate, and deactivate staff accounts
- Cashier and manager roles
- Staff profile-picture upload
- Email/password and barcode access
- Quick-login configuration and staff barcode lookup
- Staff barcode batch printing
- Permissions for sales, receipt reprints, refunds, exchanges, voids, and cash flow
- Offline staff-profile caching

### 7. Sales Analytics

- Hourly, daily, weekly, monthly, and yearly sales analysis
- Revenue, units sold, and voided-transaction KPIs
- Payment-method breakdown
- Top-product and top-category rankings
- Inventory position versus sales
- Fast-, slow-, and non-moving product analysis
- Products-needing-attention report
- Date-range and data-source filters
- Analytics export

### 8. Transaction Logs

- Complete transaction history and detailed item/payment views
- Receipt, barcode, customer, date, cashier, product, and category search
- Payment, action, status, and amount filters
- Custom date ranges and combined advanced filters
- Filter chips, clear-all controls, and saved filter presets
- Sorting by date, total, customer, or cashier
- Completed, voided, refunded, and adjusted records
- Product, category, and GCash summaries
- Transaction-data export

### 9. Audit and Cash Reconciliation

- Sales reconciliation
- Expected-versus-counted cash comparison and variance calculation
- Cash-in and cash-out review
- Cash-count and denomination history
- Z-read and shift-close report viewing
- Cashier, date, and action filters
- Protected-action audit logs
- Audit report export

### 10. Activity Logs

- Login, product, inventory, sales, and settings activity
- Discounts, voids, refunds, and exchanges
- Receipt lookups and reprints
- User, action, and date filtering
- Detailed activity descriptions
- Activity-log export and incremental loading

### 11. Admin Settings

- Software updates and appearance settings
- Export-folder configuration
- Admin and cashier quick-login management
- Developer-mode controls and authorization barcode
- Offline data download and readiness self-test
- Failed-operation review
- Product/category, staff-access, receipt, and sync-status cache maintenance
- Full terminal cache reset

### 12. Data Administration

- Legacy-import monitoring, totals, progress, and error review
- Manual and scheduled database backups
- Backup listing and retention information
- Confirmation-protected database restore
- Maintenance checks for duplicate barcodes, invalid prices/stock, uncategorized products, and orphaned sale items
- Read-only database maintenance reports

### 13. Offline Synchronization

- Offline product catalog, categories, staff logins, and manager approvals
- Offline sales, stock changes, returns, exchanges, and activity logs
- Persistent local operation queue and automatic reconnection sync
- Manual synchronization and connection-status display
- Pending, failed, and conflicting operation tracking
- Retry, use-cloud, use-local, and field-review conflict resolution
- Failed-product change removal
- Terminal identity and multi-terminal stock synchronization

### 14. Cashier POS

- Product barcode scanning and keyboard-first search
- Search by product name, barcode, or selling unit
- Keyboard navigation with out-of-stock result skipping
- Unit selection, cart management, and quantity adjustment
- Multiple transaction tabs and new/cancel transaction controls
- Stock-availability enforcement
- Customer-name and walk-in customer support
- Manager-approved discounts
- Configurable shortcuts and shortcut labels
- Online/offline status, manual sync, and session locking

### 15. Payment Processing

- Cash, GCash, and split payments
- Tendered amount, GCash reference, and customer-name capture
- Automatic change calculation
- Insufficient-payment validation
- Guided keyboard payment workflow
- Cash-drawer prompts and completed-sale confirmation

### 16. Receipt Management

- Automatic receipt generation
- Thermal ESC/POS, Windows printer, and PDF support
- Configurable printer, auto-printing, spacing, and PDF folder
- Receipt lookup, reprinting, and PDF export
- Customer and walk-in receipt formatting
- Print-queue monitoring, duplicate-job prevention, cancellation, and printer-status checks

### 17. Returns, Exchanges, and Voids

- Receipt-based transaction lookup
- Item-level refunds and exchanges
- Current and completed transaction voiding
- Manager approval and reason capture
- Return-to-stock or do-not-restock disposition
- Refund and exchange-value calculations
- Appropriate inventory restoration
- Adjustment history and permission enforcement

### 18. Cash Flow and Shift Management

- Opening shift and starting-cash entry
- Authorized cash-in and cash-out with reasons and notes
- Cash-drawer opening and cash-audit recording
- Denomination-based counts and recent cash-count history
- End-of-day reconciliation
- Expected-versus-actual cash and over/short variance reporting
- Shift closing and Z-read receipt printing
- Offline shift-close storage
- Logout confirmation and unfinished-work checks
