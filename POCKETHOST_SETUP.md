# PocketHost Setup

Use this after importing `pocketbase/pb_schema.json` in your PocketHost PocketBase admin dashboard.

## 1. Copy your PocketHost URL

In PocketHost, open your instance and copy the public PocketBase URL. It should look like:

```text
https://your-instance.pockethost.io
```

Do not include `/_/`, `/api`, or a trailing slash.

## 2. Configure the local web/admin app

Edit `.env`:

```env
POCKETBASE_URL=https://your-instance.pockethost.io
POCKETBASE_PROXY_TARGET=https://your-instance.pockethost.io
POCKETBASE_SUPERUSER_EMAIL=your-pocketbase-superuser-email
POCKETBASE_SUPERUSER_PASSWORD=your-pocketbase-superuser-password
VITE_API_URL=
```

Keep `VITE_API_URL` blank for normal local development because Vite proxies `/api` to the local Express server.

## 3. Configure the desktop/cashier build

Edit `.env.cashier`:

```env
VITE_APP_TARGET=cashier-desktop
VITE_POCKETBASE_URL=https://your-instance.pockethost.io
```

Only put public frontend values in `.env.cashier`. Do not put the PocketBase superuser password in any `VITE_` variable.

## 4. Apply collection API rules

After `.env` has the PocketHost URL and superuser credentials, run:

```bash
npm run pb:rules
```

This updates the imported schema rules used by the admin and cashier apps.

## 5. Create the first POS admin user

In the PocketBase dashboard, open the `users` collection and create a record:

```text
email: your admin login email
password: your admin login password
role: admin
status: active
name: Your Name
```

This user is different from the PocketBase superuser. The superuser logs into the PocketBase dashboard; the `users` record logs into the POS admin app.

## 6. Run locally against PocketHost

Start the backend:

```bash
npm run api
```

Start the frontend in another terminal:

```bash
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

## 7. Build the cashier desktop app

After `.env.cashier` points to PocketHost:

```bash
npm run build:cashier
npm run tauri:build
```

## Troubleshooting

- `PocketBase superuser credentials are missing`: set `POCKETBASE_SUPERUSER_EMAIL` and `POCKETBASE_SUPERUSER_PASSWORD` in `.env`.
- `Only admin accounts can access this area`: the POS login record in `users` must have `role = "admin"`.
- `Cannot reach API at /api`: run `npm run api` while using `npm run dev`.
- Browser requests fail with CORS: use the Express API path for the web app, or add your app origin in PocketBase if a frontend talks directly to PocketBase.
