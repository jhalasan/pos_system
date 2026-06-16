# NEXA POS Run Guide

This project uses:

- Vite for the React frontend
- Express for the API/backend
- PocketBase for the database

## Required Setup

Create your local `.env` from the example:

```powershell
Copy-Item .env.example .env
```

For normal local development, keep:

```env
POCKETBASE_URL=http://127.0.0.1:8090
POCKETBASE_PROXY_TARGET=http://127.0.0.1:8090
VITE_API_URL=
```

`VITE_API_URL` should stay blank when using the built-in `/api` route or the Vite proxy.

For PocketHost setup, see `POCKETHOST_SETUP.md`.

## Local Coding Mode

Use this when you are actively changing code and want hot reload.

Run these in separate terminals:

```bash
pocketbase serve
```

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

## Remote Demo Mode

Use this when your teammates need to access the system remotely from one ngrok link.

Run these in separate terminals:

```bash
pocketbase serve
```

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

## Important Notes

- Do not run `npm run api` and `npm run host` at the same time. Both use port `3001`.
- `npm run host` already builds the frontend and starts the Express server.
- PocketBase must stay running in both modes.
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

PocketBase dashboard:

```text
http://127.0.0.1:8090/_/
```

Remote demo app:

```text
https://your-ngrok-url.ngrok-free.dev
```
