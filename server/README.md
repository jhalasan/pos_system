# Admin API + PocketBase

The backend is mapped to the exported PocketBase schema in `pb_schema.json`.

An improved version is available at `pocketbase/pb_schema_improved.json`.
It keeps your existing collections, adds cashier profile fields to `users`, tightens required fields, and adds indexes used by the admin dashboard.

Collections used:

- `products`: `barcode`, `name`, `product_img`, `base_unit`, `price`, `quantity`, `min_stock`, `category`
- `categories`: `name`
- `users`: auth collection; cashier records are users with `role = "cashier"` plus `name`, `shift`, and `status`
- `activity_logs`: `user_id`, `action_type`, `description`, `timestamp`
- `sales`: `cashier_id`, `total_amount`, `payment_method`, `ref_number`, `status`, `voided_by`, `created_at`
- `sale_items`: `sale_id`, `product_id`, `quantity_sold`, `price_at_sale`

For local development:

```bash
copy .env.example .env
npm run api
npm run dev
```

Set `POCKETBASE_SUPERUSER_EMAIL` and `POCKETBASE_SUPERUSER_PASSWORD` in `.env` to any PocketBase superuser account. The older `POCKETBASE_ADMIN_EMAIL` and `POCKETBASE_ADMIN_PASSWORD` names are still supported for compatibility.

Cashier creation uses `DEFAULT_CASHIER_PASSWORD` because your `users` auth collection requires a password.

Admin login uses the PocketBase `users` auth collection. The user must have `role = "admin"`.
