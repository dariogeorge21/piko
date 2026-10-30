import { fileURLToPath } from 'node:url'
import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import zip from 'vite-plugin-zip-pack'
import manifest from './manifest.config.js'
import pkg from './package.json' with { type: 'json' }

export default defineConfig(({ command }) => ({
  // CRXJS emits development files too. Keep HMR from overwriting the installed
  // production worker/manifest while a voice session or verification is running.
  build: { outDir: command === 'serve' ? 'dist-dev' : 'dist' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
    zip({ outDir: 'release', outFileName: `crx-${pkg.name}-${pkg.version}.zip` }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Extension pages have no HTTP location.port for Vite's client to infer.
    ws: {
      host: '127.0.0.1',
      clientPort: 5173,
    },
    cors: {
      origin: [
        /^chrome-extension:\/\/[a-p]{32}$/,
      ],
    },
  },
}))
