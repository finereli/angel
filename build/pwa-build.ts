// Build-time half of the update flow (pwa skill's updates kit item),
// imported by vite.config.ts. Version = MAJOR.<build>, where the build is the
// total commit count, so it counts up by itself and never needs deciding.
// BUILD_NUMBER overrides it - that's how the update flow gets exercised
// locally, where every build would otherwise carry the same number.

import { execSync } from 'node:child_process'

export interface PwaManifest {
  name: string
  short_name: string
  description?: string
  lang?: string
  dir?: 'ltr' | 'rtl'
  start_url?: string
  scope?: string
  display?: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser'
  background_color?: string
  theme_color?: string
  icons: Array<{ src: string; sizes: string; type?: string; purpose?: string }>
  [key: string]: unknown
}

export function buildNumber(major = 1): string {
  let build = process.env.BUILD_NUMBER || 'dev'
  if (!process.env.BUILD_NUMBER) {
    try {
      build = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {}
  }
  return `${major}.${build}`
}

// vite-plugin-pwa options. The worker takes over as soon as it has
// downloaded (skipWaiting + clientsClaim); the page decides when to reload
// into it - see updates.ts, which also does the registration itself
// (injectRegister: null).
export interface PwaOptionsInput {
  manifest: PwaManifest
  includeAssets?: string[]
  globPatterns?: string[]
  maxFileSizeMB?: number
  navigateFallbackDenylist?: RegExp[]
}

export function pwaOptions({
  manifest,
  includeAssets = [],
  globPatterns = ['**/*.{js,css,html,woff2,png,svg}'],
  maxFileSizeMB = 6,
  // Paths the SPA fallback must never swallow: reset.html (the out-of-band
  // escape hatch, also never precached, so it works even when the app is
  // stuck).
  navigateFallbackDenylist = [/^\/reset(\.html)?$/],
}: PwaOptionsInput) {
  return {
    registerType: 'autoUpdate' as const,
    injectRegister: null,
    includeAssets,
    manifest,
    // Keep the filename index.html already links to.
    manifestFilename: 'manifest.json',
    workbox: {
      globPatterns,
      maximumFileSizeToCacheInBytes: maxFileSizeMB * 1024 * 1024,
      navigateFallback: '/index.html',
      skipWaiting: true,
      clientsClaim: true,
      globIgnores: ['**/node_modules/**/*', '**/reset.html'],
      navigateFallbackDenylist,
    },
  }
}
