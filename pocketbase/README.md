# PocketBase Schema

Import `pb_schema.json` from the PocketBase dashboard:

1. Open PocketBase Admin.
2. Go to Settings > Import collections.
3. Select `pocketbase/pb_schema.json`.
4. Import the collections.

This schema includes the fields required by the POS backend:

- `users.quick_login_enabled`
- `products.allow_fractional` for products sold in decimal quantities (e.g. rice by the kilogram)
- `sales.transaction_no` using daily sequence format `YYYYMMDD0001`
- unique `idx_sales_transaction_no` index to prevent duplicate transaction numbers
- cascading deletion of a sale's dependent `sale_items`

The backend expects these fields to exist and no longer creates them automatically at runtime.

## Cashier barcode login on the store server (`pb_hooks`)

`pb_hooks/nexa_barcode_login.pb.js` adds one route to the store's own PocketBase,
`POST /api/nexa/barcode-login`, so a cashier can sign in by barcode **without the
internet**. Without it, barcode login is verified by the Vercel API; when the
internet (or Vercel) is down the terminal cannot verify the barcode, falls back to
an old saved session that has usually expired, and then stops uploading every sale
until someone signs in with an email and password. Sales only ever need the store
network, so the login that unlocks them should not need the internet either.

The route is optional. Terminals try it first and, if it is not installed (404) or
the server cannot answer, fall back to the Vercel API exactly as before. It issues
a normal 7-day session that renews itself (the Vercel route issues a 12-hour one),
accepts only active accounts with the `cashier` role (never managers), and limits
failed attempts to 8 per 5 minutes per computer (answered with 403, so a few
mistaken scans cannot pause syncing).

**Install** (on the mini-PC that runs PocketBase; no schema or data change):

1. Open the folder that contains the PocketBase executable (the one with `pb_data`).
2. Create a folder named `pb_hooks` there if it does not exist, and copy
   `pocketbase/pb_hooks/nexa_barcode_login.pb.js` into it.
3. Restart PocketBase. It is back in a few seconds; terminals keep selling and queue
   their sales while it restarts.
4. Check it is installed (an unknown barcode must answer **401**, not 404):

   ```
   curl.exe -i -X POST http://<mini-pc-ip>:8090/api/nexa/barcode-login -H "Content-Type: application/json" -d "{\"barcode\":\"not-a-real-barcode\"}"
   ```

   `HTTP/1.1 401` with `Invalid cashier barcode.` means it is working. `404` means
   the file is not in the right `pb_hooks` folder or PocketBase was not restarted.

**Remove:** delete the file and restart PocketBase. Terminals return to the Vercel
route on their own.
