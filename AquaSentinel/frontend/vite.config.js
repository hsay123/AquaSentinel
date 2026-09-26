import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend mounts its routes at the root (/health, /waterbodies, ...) while
// the frontend calls them under an /api prefix. The proxy MUST strip that
// prefix, otherwise every request is forwarded verbatim to /api/* and FastAPI
// answers 404 — which the UI surfaces as "Failed to load waterbodies" and,
// because /health 404s too, pins the header badge to "GEE Offline" even when
// Earth Engine is perfectly healthy.
//
// Shared by `vite dev` and `vite preview` so a built bundle demoed on another
// machine talks to the backend the same way the dev server does.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || 'http://localhost:8000'

const apiProxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
})
