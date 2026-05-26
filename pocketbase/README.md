# PocketBase Schema

Import `pb_schema.json` from the PocketBase dashboard:

1. Open PocketBase Admin.
2. Go to Settings > Import collections.
3. Select `pocketbase/pb_schema.json`.
4. Import the collections.

This schema includes the fields required by the POS backend:

- `users.quick_login_enabled`
- `sales.transaction_no`

The backend expects these fields to exist and no longer creates them automatically at runtime.
