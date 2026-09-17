import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { buildNumber, pwaOptions } from './shared/build/pwa-build'

// Seams: MAJOR, the manifest, includeAssets.
const MAJOR = 1

export default defineConfig({
  root: 'src/client',
  define: {
    __BUILD__: JSON.stringify(buildNumber(MAJOR)),
  },
  resolve: {
    // Code shared across the client (and any future sibling app).
    alias: { $shared: fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  plugins: [
    svelte(),
    VitePWA(
      pwaOptions({
        includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'logo-mark.svg'],
        manifest: {
          name: 'Angel',
          short_name: 'Angel',
          description: 'A companion agent with one continuous stream and a memory that compresses instead of forgetting.',
          lang: 'en',
          dir: 'ltr',
          start_url: '/chat',
          scope: '/',
          display: 'standalone',
          background_color: '#1e1e2e',
          theme_color: '#6366f1',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      })
    ),
  ],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
})