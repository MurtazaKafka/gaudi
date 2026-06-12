import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honor the preview harness's assigned port; fall back to Vite's default.
    port: Number(process.env.PORT) || 5173,
  },
})
