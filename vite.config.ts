import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'esnext',
    rollupOptions: { input: { sidepanel: 'src/ui/sidepanel/index.html', options: 'src/ui/options/index.html', popup: 'src/ui/popup/index.html' } },
  },
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
  test: { environment: 'happy-dom', globals: true, include: ['tests/**/*.test.ts'] },
})
