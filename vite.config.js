import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isCashierBuild = mode === 'cashier'

  return {
    plugins: [react()],
    clearScreen: false,
    define: {
      'import.meta.env.VITE_APP_TARGET': JSON.stringify(
        isCashierBuild ? 'cashier-desktop' : '',
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
