# Vercel Admin Portal Deployment

This deployment publishes only the remote administrator portal. The cashier POS, Tauri integrations, printer controls, terminal cache maintenance, and offline terminal settings remain desktop-only.

## 1. Before deploying

1. Create a separate PocketBase database for Vercel Preview deployments. Do not point unreviewed preview builds at client production data.
2. Confirm every remote administrator has an active `users` record with `role = "admin"`.
3. Rotate any PocketBase superuser password that has previously been committed, shared, or displayed.
4. Make a current PocketBase backup.

## 2. Import the project into Vercel

Import the Git repository as a new Vercel project. The committed `vercel.json` selects the admin-only build and configures React Router fallbacks.

- Framework preset: **Vite**
- Build command: **npm run build:vercel**
- Output directory: **dist**
- Install command: **npm install**

## 3. Environment variables

Configure these in **Project Settings > Environment Variables**:

| Variable | Value | Exposure |
| --- | --- | --- |
| `VITE_APP_TARGET` | `admin-web` | Browser build |
| `VITE_API_URL` | `/api` | Browser build |
| `VITE_POCKETBASE_URL` | Production or preview PocketBase URL | Browser build |
| `POCKETBASE_URL` | Same PocketBase URL | Server only |
| `POCKETBASE_PROXY_TARGET` | Same PocketBase URL | Server only |
| `POCKETBASE_SUPERUSER_EMAIL` | PocketBase service/superuser email | Secret, server only |
| `POCKETBASE_SUPERUSER_PASSWORD` | PocketBase service/superuser password | Secret, server only |
| `CLIENT_ORIGIN` | Exact Vercel/custom domain, such as `https://admin.example.com` | Server only |
| `AUTO_BACKUP_ENABLED` | `false` | Server only |
| `VITE_SUPPORT_EMAIL` | Client support email | Browser build |
| `VITE_SUPPORT_PHONE` | Client support phone | Browser build |

Never prefix a secret with `VITE_`; Vite variables are embedded into downloadable browser code.

Use separate values for Preview and Production. Preview should use its own PocketBase instance and credentials.

## 4. PocketBase configuration

Add the production portal domain and required Vercel preview domains to PocketBase trusted origins/CORS configuration. Keep PocketBase collection rules restrictive even though the server API also validates the signed-in user's token and admin role.

The API rejects missing, expired, inactive, and non-admin sessions. All protected requests use `Authorization: Bearer <PocketBase token>`.

## 5. Deploy and verify

After the first deployment:

1. Open `/admin-login` and confirm the role selection and cashier pages are unavailable.
2. Confirm invalid and cashier accounts cannot enter the portal.
3. Sign in with a test admin account.
4. Load dashboard, products, inventory, analytics, transactions, audit, and activity logs.
5. Make one test product edit and confirm it appears in PocketBase and on a synchronized desktop terminal.
6. Sign out and confirm protected API requests return HTTP 401.
7. Confirm local cache, printer, import, backup/restore, and offline readiness controls are absent.

## 6. Domains and production release

Attach a dedicated domain such as `admin.example.com`, update `CLIENT_ORIGIN`, and redeploy. Enable Vercel deployment protection for Preview environments where available.

The Express automatic-backup timer is intentionally disabled on Vercel because serverless functions are not persistent processes. Keep backups on PocketHost/a persistent service, or add a separately authenticated scheduled backup endpoint before using Vercel Cron.

## Local verification

Build the same artifact Vercel will deploy:

```powershell
npm run build:vercel
npm run preview
```

For complete API testing, run the Express API with the required server-side environment variables and set `VITE_API_URL` to its URL during development.
