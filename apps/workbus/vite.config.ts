import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Start on Workers through Cloudflare's Vite plugin: vite dev runs the app in workerd, with its
// bindings, and the WORKBUS binding reaches the bus in its own wrangler dev (pnpm dev:bus). Live,
// /b/* on workbus.dev is the bus's route; here the dev server sends it there, so the browser calls
// the bus on the same origin in both.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { proxy: { '/b/': { target: 'http://127.0.0.1:8832', changeOrigin: false } } },
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tailwindcss(), tanstackStart(), react()],
})
