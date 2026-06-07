# Build the Windows Cashier Installer

The Tauri build packages only the cashier entry point. The normal `npm run build`
command still produces the browser application with the admin dashboard.

## 1. Install Windows prerequisites

Install Visual Studio Build Tools 2022:

1. Download <https://aka.ms/vs/17/release/vs_BuildTools.exe>.
2. Select **Desktop development with C++**.
3. Ensure MSVC and a Windows 10 or Windows 11 SDK are selected.

Install Rust with the MSVC toolchain:

```powershell
winget install --id Rustlang.Rustup
```

Restart PowerShell, then verify:

```powershell
rustup default stable-msvc
rustc --version
cargo --version
npx tauri info
```

## 2. Configure the cloud PocketBase URL

Create `.env.cashier` beside `package.json`:

```dotenv
VITE_POCKETBASE_URL=https://your-pocketbase.example.com
```

This URL is compiled into the cashier frontend and is not a secret. Never put a
PocketBase superuser password or other server credential in a `VITE_` variable.

PocketBase must use HTTPS in production. Its API rules must allow an authenticated
cashier to create sales and read products. The `sales.client_sale_id` field should
have a unique index so synchronization retries cannot create duplicate sales.

## 3. Run the desktop app during development

```powershell
npm install
npm run tauri:dev
```

The first online login downloads products into Dexie. Product search, barcode
lookup, stock validation, and checkout then use the local IndexedDB database.

## 4. Build the `.exe` installer

```powershell
npm run tauri:build
```

The NSIS installer is written to:

```text
src-tauri\target\release\bundle\nsis\Nexa POS Cashier_0.1.0_x64-setup.exe
```

The exact filename can vary slightly with the configured version and CPU target.
Copy the generated installer to the shop computer and run it as the Windows user
who will operate the cashier terminal.

## Release checklist

- Set the real HTTPS `VITE_POCKETBASE_URL`.
- Import the required PocketBase schema and unique indexes.
- Test one checkout with the network disconnected.
- Reconnect and confirm the queued sale appears once in PocketBase.
- Code-sign the installer before public or wide internal distribution.
