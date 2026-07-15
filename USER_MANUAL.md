# NEXA POS System User Manual

## 1. Overview

NEXA POS is an offline-ready point-of-sale and inventory system for retail stores. It supports:

- Admin and cashier workspaces
- Barcode-based sales and inventory scanning
- Cash and GCash payments
- Product, category, stock, and staff management
- Refunds, exchanges, voids, and receipt reprinting
- Reports, transaction history, audit logs, and activity logs
- Local offline operation with queued cloud synchronization
- Database backups, restore, and maintenance checks

## 2. Getting Started

### 2.1 Choose a workspace

On the role-selection screen, choose:

- **Admin** for products, inventory, staff, analytics, logs, settings, and data administration.
- **Cashier** for sales, payments, receipts, returns, and shift operations.

The connection indicator shows whether the terminal is online, offline, or synchronizing. Offline does not mean that local work is lost; supported changes are stored on the terminal and uploaded when a connection returns.

### 2.2 Admin login

1. Select **Continue as Admin**.
2. Enter the admin email and password, or select an available quick-login profile.
3. Select **Login**.

### 2.3 Cashier login

1. Select **Open Cashier POS**.
2. Choose **Barcode** or **Email**.
3. Scan or enter the cashier barcode, or enter the cashier email and password.
4. Complete the login.

Offline cashier login works only after that cashier profile has been downloaded to the terminal while online.

## 3. Admin Workspace

### 3.1 Dashboard

The dashboard is the main operational overview. Use the source and date filters to separate live POS activity from legacy or test data. Depending on available records, it shows:

- Today's sales, transaction count, average sale, and payment totals
- Critical and out-of-stock products
- Inventory health
- Recent transactions
- Top products and categories
- Seven-day sales movement
- Data-quality and synchronization warnings

Dashboard cards and quick actions open the related administration pages.

### 3.2 Product Management

Use Product Management to:

- Add and edit products
- Create and assign categories
- Set barcodes, prices, stock limits, and selling units
- Archive or delete products
- Export or print the inventory catalog
- Review missing barcodes, uncategorized items, invalid prices, negative inventory, and duplicate barcodes

The list displays 20 products at a time. Use **See more products** to load another group. Search and filters apply before additional products are loaded.

Available sorting includes:

- Name A–Z or Z–A
- Stock low to high or high to low
- Product stock status

#### Product status

- **In Stock**: quantity is above the configured low-stock level.
- **Low Stock**: quantity is at or below the configured low-stock level.
- **Critical Stock**: only a very small quantity remains.
- **Out of Stock**: quantity is zero.
- **Archived**: hidden from normal selling and active-product views but retained for historical records.

Prefer archiving a product that appears in transaction history. Delete only incorrect or unused records.

### 3.3 Inventory

#### Stock In

1. Open **Inventory**.
2. Scan or search for the product.
3. Select the correct unit.
4. Enter the received quantity.
5. Review the base-unit equivalent when multiple units are configured.
6. Confirm the stock entry.

#### Stock Out

1. Open **Inventory** and choose the stock-out workflow.
2. Scan or search for the product.
3. Select the unit and quantity being removed.
4. Enter the reason when requested.
5. Confirm the stock-out entry.

#### Physical Reconciliation / Stock Adjustment

Use reconciliation when a physical count differs from the quantity stored in NEXA POS. Do not use it for normal purchases or sales.

1. Open **Inventory > Physical Reconciliation**.
2. Select the product.
3. Enter the actual physical count.
4. Select an adjustment reason and add a useful note.
5. Review the system quantity, physical quantity, and variance.
6. Approve the adjustment.

The adjustment changes the quantity to the physical count and records the previous quantity, new quantity, variance, reason, user, and time. When offline, it remains queued until synchronization succeeds.

Recommended reasons include damaged stock, expired stock, counting correction, supplier discrepancy, or shrinkage. Investigate large or repeated variances rather than repeatedly adjusting them without explanation.

### 3.4 Staff and Cashier Management

Admins can add, edit, activate, or deactivate cashier and manager accounts. Cashier barcodes may be generated for quick login.

To add or replace a staff profile picture, open the staff record, select the picture area, choose an image, and save the changes. Staff records created on older terminals remain compatible after current data is downloaded. If a terminal reports that a staff ID is missing, refresh Staff Management and synchronize before trying again.

Cashier permissions include:

- Process sales
- Reprint receipts
- Request refunds
- Request exchanges
- Request transaction voids
- Record cash in/out

Disabling a permission removes that function from the cashier. Protected actions still require manager approval even when the cashier has permission to request them.

After changing staff details or permissions, synchronize and refresh offline data on every terminal that needs the updated access.

### 3.5 Analytics, Transactions, Audit, and Activity Logs

- **Analytics** shows sales and inventory trends and can be filtered by date and data source.
- **Transaction Logs** contains completed, voided, refunded, and adjusted sales where available. Its main filters cover receipt or barcode search, date, customer, product, and category. Select **Advanced Filters** for cashier, payment method, amount range, action, and status. Filters can be combined, removed individually from the filter chips, cleared together, or saved as reusable presets.
- Transaction results can be sorted by date, total, customer, or cashier. Open a row for the full item and payment breakdown. The Product Summary and Category Summary tabs show filtered quantity and revenue totals, while the GCash Payments tab isolates electronic-payment records.
- **Audit** is used for protected or business-sensitive events.
- **Activity Logs** records system actions such as logins, product changes, stock adjustments, and sales activity.

Use **All Time** when older records do not appear under the default date filter. Export options create a file from the currently available report data.

## 4. Cashier Workspace

### 4.1 Process a sale

1. Scan a barcode or search for a product.
2. Select the correct selling unit when prompted.
3. Adjust the quantity if needed.
4. Review the cart and totals.
5. Select **Complete Transaction**.
6. Choose Cash, GCash, or Split and enter the required payment information.
7. Press **Enter** to continue to Customer Name.
8. Enter an optional customer name, or leave the field blank for Walk-in Customer, then press **Enter**.
9. Follow the on-screen change and cash-drawer prompts using **Enter**.
10. Press **Enter** at the receipt step to print.

The system prevents a sale when there is not enough available stock for the selected unit.

#### Keyboard-first product search

- Use the configured Search Product shortcut to focus product search.
- Type part of a product name, barcode, or selling unit.
- Press **Down Arrow** or **Up Arrow** to move through results. The list scrolls automatically and skips out-of-stock products.
- Press **Home** or **End** to jump to the first or last available result.
- Press **Enter** to select the highlighted product.
- Press **Escape** to clear search and return to barcode scanning.

Dialogs automatically focus the first relevant input. In most cashier dialogs, **Enter** activates the primary OK, Proceed, Confirm, or Continue action; **Escape** cancels or returns; and **Tab** or **Shift+Tab** moves between controls without leaving the dialog. A focused button also responds to **Enter** normally.

### 4.2 Receipts

Completed receipts are stored in transaction history. A cashier with receipt-reprint permission can open a transaction and print another copy.

When a customer name was entered, it appears on printed receipts, PDF copies, reprints, transaction details, and exports. Walk-in transactions omit the customer line on the printed receipt and appear as Walk-in in Transaction Logs.

Thermal receipt printers receive ESC/POS output. If a Windows virtual PDF printer such as Microsoft Print to PDF is selected, NEXA POS automatically uses its PDF generator instead of sending thermal-printer commands. Existing zero-byte PDF files cannot be repaired; generate the receipt again after correcting or updating the printer configuration.

### 4.3 Refunds and exchanges

Refunds, exchanges, and voids require the related cashier permission and manager authorization.

For a refund or exchange, choose the returned-item disposition:

- **Return to available stock** for unopened or sellable merchandise.
- **Do not restock (damaged/expired)** when the item must not be sold again.

The selected disposition is saved with the adjustment. Never return damaged, expired, contaminated, or incomplete goods to available inventory.

### 4.4 Cash flow and shift closing

Use Cash Flow to record authorized cash-in and cash-out activity. At the end of a shift:

1. Finish or cancel any open sale.
2. Review completed transactions and expected cash.
3. Count the drawer.
4. Record the closing information and print any required shift report.
5. Synchronize pending changes when a connection is available.
6. Log out.

## 5. Offline Operation and Synchronization

### 5.1 Prepare a terminal for offline use

While connected to the network:

1. Open **Settings > Offline Readiness**.
2. Select **Download Latest Data for Offline Use**.
3. Confirm the terminal, product catalog, categories, staff login profiles, and manager approval methods are available.
4. Select **Run Offline Self-Test**.
5. Confirm the result says **Ready for Offline Use**.

**Offline Data Incomplete** means one or more required items have not been cached or the self-test has not passed. Review the failed step, reconnect, download again, and repeat the test.

### 5.2 Working offline

When offline:

- Cached products remain searchable and sellable.
- Authorized staff can use cached login methods.
- Sales, stock changes, returns, and supported logs are stored locally.
- The status bar shows that uploads are waiting for a connection.

Do not clear browser/app data or uninstall the application while changes are pending. Doing so can remove unsynchronized local records.

### 5.3 Sync Center

Select **Sync to Cloud** to open Sync Center. It shows waiting, failed, and conflicting local changes.

- **Retry All** retries pending and failed uploads.
- **Use Cloud**, **Use Local**, or **Review Fields** resolves a data conflict.
- **Discard** and **Discard Failed Products** remove obsolete failed product changes and their local cached copies.

Discard is intended for products that were deliberately removed from PocketBase or for unwanted test products. It does not recreate the cloud record and cannot be undone. Never discard sales, stock movements, or legitimate client changes merely to remove a warning.

When the queue reaches zero, the interface updates to **Everything is synchronized**.

### 5.4 Local cache maintenance

Use **Settings > Offline Readiness > Local Cache Maintenance** only when cached terminal data is stale or troubleshooting requires a fresh local copy. You can reset the product and category cache, cached staff access, cached receipts, old sync status, or all terminal cache data.

Before a reset:

1. Open **Sync to Cloud** and confirm there are no waiting, failed, or conflicting changes.
2. Stay online if the product or staff cache must be downloaded again immediately.
3. Select the smallest reset scope that addresses the problem.
4. Enter the exact confirmation **RESET TERMINAL**.

The reset does not delete PocketBase cloud records, the terminal identity, printer settings, or application preferences. Product and staff reset options automatically download a fresh offline copy when the terminal is online. The application refuses to reset local data while sales or synchronization operations remain queued.

## 6. Data Administration

Open **Settings > Data Administration** for legacy import monitoring, backups, restore, and maintenance checks.

### 6.1 Legacy import monitor

The monitor shows the import mode, planned products and sales, and completion state. **Incomplete / stopped** means an import did not reach its normal completion marker; it does not automatically mean imported records are corrupt. Review the import output and recent errors before rerunning it.

### 6.2 Backups

- **Run Scheduled Backup** applies the configured automatic-backup policy.
- **Create Backup** creates a manual PocketBase backup.
- Automatic backups run at the displayed interval and retain the displayed number of files.

Create a backup before imports, bulk cleanup, schema changes, or major catalog corrections. Backup controls require the local API service and a reachable PocketBase server.

### 6.3 Restore

Restore replaces current PocketBase data with the selected backup.

1. Ensure all terminals have synchronized or stopped entering data.
2. Select the correct backup.
3. Enter the exact confirmation requested by the screen.
4. Restore and allow PocketBase to restart.
5. Reopen the application and download current offline data to each terminal.

Records created after the selected backup may be lost. Restore only with administrator authorization.

### 6.4 Database maintenance report

The maintenance report checks for duplicate barcodes, invalid prices, invalid stock, uncategorized products, and orphaned sale items. It is read-only and does not automatically modify records. Create a backup before making bulk corrections.

## 7. Troubleshooting

### Dashboard or another page remains on Loading

1. Check the connection indicator.
2. Wait for any current synchronization to finish.
3. Navigate away and return once.
4. Restart the application if the page remains stuck.
5. Run the offline self-test and contact support if the problem repeats.

### Cannot log in offline

- Reconnect and download the latest offline data.
- Confirm the staff account is active.
- Confirm the terminal has a cached login profile.
- For protected actions, confirm a manager or authorization barcode is cached.

### Barcode does not scan

- Confirm the scanner is connected and sending keyboard input.
- Clean or reprint unreadable labels.
- Type the barcode manually.
- Confirm the barcode belongs to the correct product and selling unit.

### Inventory is incorrect

- Review recent stock and transaction logs.
- Confirm the correct selling-unit conversion was used.
- Perform a physical count.
- Use Physical Reconciliation with a reason and note when an adjustment is justified.

### Sync remains failed

- Open Sync Center and read the error on the failed record.
- Correct missing fields such as price or category, then retry.
- Confirm the cloud server is reachable and the user is still authorized.
- Discard a failed product operation only when the cloud product was intentionally deleted or the local record is unwanted test data.

### Backup request fails

- Start the local API service if it is not running.
- Confirm PocketBase is reachable and the administrator credentials are configured.
- Retry after a rate-limit or temporary hosting error has cleared.

### Receipt does not print

- Confirm the printer is powered on and connected.
- Check the selected printer and paper size.
- Confirm a physical thermal printer is selected for normal receipt printing.
- For a soft copy, use the PDF receipt action or a supported PDF printer. Do not expect an older zero-byte PDF to open; generate it again.
- Reopen the transaction and use receipt reprint if permitted.

### Product search does not follow the highlighted result

- Keep focus in the Search Product field while using Up Arrow and Down Arrow.
- Use Home or End to jump within the result list.
- Out-of-stock products are skipped during keyboard selection.
- Press Escape, refocus Search Product, and try again if another dialog took focus.

## 8. Daily Best Practices

- Synchronize and run the offline readiness check before opening the store.
- Keep product names, barcodes, categories, prices, and unit conversions accurate.
- Use Stock In and Stock Out for normal movement; reserve reconciliation for verified count differences.
- Record a clear reason for refunds, voids, exchanges, and stock adjustments.
- Review failed synchronization items before closing the shift.
- Create backups before imports, cleanup, or structural changes.
- Never share admin, manager, or authorization credentials.
- Do not use production client data for automated end-to-end testing.

## 9. Support

When contacting support, provide:

- Terminal name and ID
- Date and approximate time of the problem
- Current online/offline and sync status
- The exact error message
- Transaction number, product name, or barcode involved
- A screenshot that does not expose passwords or private credentials
