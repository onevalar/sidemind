import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The API server runs separately; in dev the browser talks to Vite and Vite forwards /api.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Supervised orb previews provide one exact public hostname, never an unrestricted allowlist.
    allowedHosts: process.env.PUBLIC_URL ? [new URL(process.env.PUBLIC_URL).hostname] : [],
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
})
