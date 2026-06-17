# NEXA POS Run Guide

This project uses:

- Vite for the React frontend
- Express for the API/backend
- PocketHost.io for the hosted PocketBase database

## Required Setup

The current deployment setup uses PocketHost.io as the PocketBase host. Local PocketBase is only needed if you intentionally want an offline/local database for development.

Create your local `.env` from the example:

```powershell
Copy-Item .env.example .env
```

For the current PocketHost-backed setup, use:

```env
POCKETBASE_URL=https://your-instance.pockethost.io
POCKETBASE_PROXY_TARGET=https://your-instance.pockethost.io
POCKETBASE_SUPERUSER_EMAIL=your-pocketbase-superuser-email
POCKETBASE_SUPERUSER_PASSWORD=your-pocketbase-superuser-password
VITE_API_URL=
```

`VITE_API_URL` should stay blank when using the built-in `/api` route or the Vite proxy.

For the full PocketHost setup checklist, see `POCKETHOST_SETUP.md`.

## Local Coding Mode

Use this when you are actively changing code and want hot reload.

Run these in separate terminals:

```bash
npm run api
```

```bash
npm run dev
```

Open the Vite local URL:

```text
http://localhost:5173
```

If Vite chooses another port, use the URL it prints, such as:

```text
http://localhost:5174
```

Do not use ngrok for local-only coding.

If you choose to use a local PocketBase database instead of PocketHost, run `pocketbase serve` separately and set `POCKETBASE_URL` plus `POCKETBASE_PROXY_TARGET` to `http://127.0.0.1:8090`.

## LAN Team Testing Mode

Use this when teammates are on the same Wi-Fi/network and need to open the app from another device.

Run these in separate terminals:

```bash
npm run api
```

```bash
npm run dev:lan
```

Give teammates your computer's LAN URL from the Vite output, usually:

```text
http://<this-computer-ip>:1420
```

If teammates run their own frontend but use your API, set their frontend `.env` to:

```env
VITE_API_URL=http://<your-computer-ip>:3001/api
```

The API now accepts `localhost`, common private-network IPs, and configured `CLIENT_ORIGIN` values.

## Remote Demo Mode

Use this when your teammates need to access the system remotely from one public link, even when they are not on the same Wi-Fi/network.

Because the database is on PocketHost, set `.env` like this first:

```env
POCKETBASE_URL=https://your-instance.pockethost.io
POCKETBASE_PROXY_TARGET=https://your-instance.pockethost.io
POCKETBASE_SUPERUSER_EMAIL=your-pocketbase-superuser-email
POCKETBASE_SUPERUSER_PASSWORD=your-pocketbase-superuser-password
VITE_API_URL=
```

Then run these in separate terminals:

```bash
npm run host
```

```bash
ngrok http 3001
```

Give your teammates the ngrok root URL:

```text
https://your-ngrok-url.ngrok-free.dev
```

They should open the root URL, not `/api`.

With this setup, teammates do not need the same Wi-Fi, your LAN IP, or any `.env` file. Their browser talks to your public ngrok app URL, and your Express server talks to PocketHost.

If you are using a local PocketBase database instead of PocketHost, also keep `pocketbase serve` running before `npm run host`.

## Permanent Remote Mode

For a URL that does not change, deploy the Express app to a public Node host such as Render, Railway, Fly.io, or a VPS.

Set these environment variables on the deployed server:

```env
POCKETBASE_URL=https://your-instance.pockethost.io
POCKETBASE_PROXY_TARGET=https://your-instance.pockethost.io
POCKETBASE_SUPERUSER_EMAIL=your-pocketbase-superuser-email
POCKETBASE_SUPERUSER_PASSWORD=your-pocketbase-superuser-password
VITE_API_URL=
```

Most public hosts set `PORT` automatically. Set `API_PORT` only if your host asks you to choose a fixed port.

Use this build command:

```bash
npm run build
```

Use this start command:

```bash
npm start
```

Then give teammates the deployed app URL.

## Important Notes

- Do not run `npm run api` and `npm run host` at the same time. Both use port `3001`.
- `npm run host` builds the frontend and starts the Express server for temporary hosting. Production deployments should use `npm run build` plus `npm start`.
- PocketBase must stay running only when you use a local PocketBase database. PocketHost stays online by itself.
- Your teammates do not need `.env` if they only open your ngrok app link.
- If teammates run the frontend locally, they need:

```env
VITE_API_URL=https://your-ngrok-url.ngrok-free.dev/api
```

Then they open their own Vite URL, usually:

```text
http://localhost:5173
```

## Common URLs

Local Vite app:

```text
http://localhost:5173
```

Local Express API:

```text
http://localhost:3001/api/health
```

PocketHost PocketBase dashboard:

```text
https://your-instance.pockethost.io/_/
```

Local PocketBase dashboard, only if using local development database:

```text
http://127.0.0.1:8090/_/
```

Remote demo app:

```text
https://your-ngrok-url.ngrok-free.dev
```
