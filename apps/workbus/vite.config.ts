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
  server: { proxy: { '/b/': { target: process.env.WORKBUS_BUS ?? 'http://127.0.0.1:8832', changeOrigin: false } } },
  plugins: [
    // TODO(step 2): drop this and src/shims/node-crypto.ts once reader's doctext split (hashOf and
    // track moved to ledger/doctrack.ts, framework/read-state 6770bb7, PR #4) is in this branch.
    // Until then the client build resolves node:crypto, which doctext.ts imports, to a stub.
    { name: 'workbus-browser-node-crypto', enforce: 'pre', resolveId: function (id) { return id === 'node:crypto' && this.environment.name === 'client' ? new URL('./src/shims/node-crypto.ts', import.meta.url).pathname : null } },
    cloudflare({ viteEnvironment: { name: 'ssr' }, ...(process.env.INSPECTOR_PORT ? { inspectorPort: Number(process.env.INSPECTOR_PORT) } : {}) }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
})
