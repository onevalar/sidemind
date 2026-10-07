import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API server runs separately; in dev the browser talks to Vite and Vite forwards /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
