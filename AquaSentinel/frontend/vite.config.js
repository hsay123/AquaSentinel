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

// The backend serves the real Sentinel-2 composites under /render-assets, the
// per-alert evidence pair under /evidence-assets, and the pre-warmed grouped
// composites under /composite-assets. They must be proxied too: the SPA
// fallback answers any unknown path with index.html and a 200, so an unproxied
// <img> fails to decode silently and the map quietly falls back to
// street tiles while the legend still claims "real Sentinel-2 true colour".
const proxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
  '/render-assets': { target: BACKEND, changeOrigin: true },
  '/evidence-assets': { target: BACKEND, changeOrigin: true },
  // Pre-warmed composites, grouped per (water body, date).
  '/composite-assets': { target: BACKEND, changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
})
