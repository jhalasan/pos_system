import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const DEFAULT_POCKETBASE_URL = 'https://nexasystems.pockethost.io'
const DEFAULT_RECEIPT_PRINTER_NAME = 'XP-58H'
const DEFAULT_RECEIPT_COPIES = '2'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isCashierBuild = mode === 'cashier'
  const appTarget = isCashierBuild ? 'cashier-desktop' : ''

  return {
    plugins: [react()],
    clearScreen: false,
    define: {
      'import.meta.env.VITE_APP_TARGET': JSON.stringify(process.env.VITE_APP_TARGET || appTarget),
      'import.meta.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL || ''),
      'import.meta.env.VITE_POCKETBASE_URL': JSON.stringify(
        process.env.VITE_POCKETBASE_URL || process.env.POCKETBASE_URL || DEFAULT_POCKETBASE_URL,
      ),
      'import.meta.env.VITE_RECEIPT_PRINTER_NAME': JSON.stringify(
        process.env.VITE_RECEIPT_PRINTER_NAME || DEFAULT_RECEIPT_PRINTER_NAME,
      ),
      'import.meta.env.VITE_RECEIPT_COPIES': JSON.stringify(
        process.env.VITE_RECEIPT_COPIES || DEFAULT_RECEIPT_COPIES,
      ),
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
