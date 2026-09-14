import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.config'

// A stamp baked into every bundle of a single build. The panel compares its
// own against the background worker's, which is the only reliable way to spot
// Chrome serving fresh pages beside a worker it never restarted.
const BUILD_ID = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'esnext',
    rollupOptions: { input: { sidepanel: 'src/ui/sidepanel/index.html', options: 'src/ui/options/index.html', popup: 'src/ui/popup/index.html' } },
  },
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
  test: { environment: 'happy-dom', globals: true, include: ['tests/**/*.test.ts'] },
})
