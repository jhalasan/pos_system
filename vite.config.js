import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The store migrated off PocketHost to a self-hosted local PocketBase
// (192.168.0.114:8090) on 2026-09-05. This fallback is a defense-in-depth
// safety net for any build invocation that forgets to set
// VITE_POCKETBASE_URL/POCKETBASE_URL explicitly -- it must track wherever
// the store's PocketBase actually lives, not the decommissioned PocketHost
// instance. Confirmed live: the GitHub Actions release workflow had never
// set either env var, so every CI-built release before this fix silently
// baked in the old PocketHost URL via this exact constant.
const DEFAULT_POCKETBASE_URL = 'http://192.168.0.114:8090'
const DEFAULT_ADMIN_API_URL = 'https://pos-system-taupe-eight.vercel.app/api'
const DEFAULT_RECEIPT_PRINTER_NAME = 'XP-58H'
const DEFAULT_RECEIPT_COPIES = '2'
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isCashierBuild = mode === 'cashier'
  const isAdminWebBuild = mode === 'admin-web'
  const appTarget = isCashierBuild ? 'cashier-desktop' : (isAdminWebBuild ? 'admin-web' : '')
  const appEntry = isCashierBuild
    ? 'src/DesktopApp.jsx'
    : (isAdminWebBuild ? 'src/AdminWebApp.jsx' : 'src/App.jsx')

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@app-target': path.resolve(projectRoot, appEntry),
      },
    },
    clearScreen: false,
    define: {
      'import.meta.env.VITE_APP_TARGET': JSON.stringify(process.env.VITE_APP_TARGET || appTarget),
      'import.meta.env.VITE_API_URL': JSON.stringify(
        process.env.VITE_API_URL || (isCashierBuild ? DEFAULT_ADMIN_API_URL : ''),
      ),
      'import.meta.env.VITE_POCKETBASE_URL': JSON.stringify(
        process.env.VITE_POCKETBASE_URL || process.env.POCKETBASE_URL || DEFAULT_POCKETBASE_URL,
      ),
      'import.meta.env.VITE_RECEIPT_PRINTER_NAME': JSON.stringify(
        process.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_RECEIPT_PRINTER_NAME,
      ),
      'import.meta.env.VITE_RECEIPT_COPIES': JSON.stringify(
        process.env.VITE_RECEIPT_COPIES || DEFAULT_RECEIPT_COPIES,
      ),
      'import.meta.env.VITE_SUPPORT_EMAIL': JSON.stringify(process.env.VITE_SUPPORT_EMAIL || ''),
      'import.meta.env.VITE_SUPPORT_PHONE': JSON.stringify(process.env.VITE_SUPPORT_PHONE || ''),
      'import.meta.env.VITE_SUPPORT_API_URL': JSON.stringify(process.env.VITE_SUPPORT_API_URL || ''),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version || '0.0.0'),
    },
    server: {
      port: 1420,
      strictPort: true,
      proxy: {
        '/api': 'http://localhost:3001',
      },
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
  }
})
