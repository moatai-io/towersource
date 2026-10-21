import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { resolveFrontendSourceRev } from './scripts/frontend-source-rev.mjs';
import { malformedPathGuard } from './scripts/vite-request-guard';

const frontendSourceRev = resolveFrontendSourceRev();

export default defineConfig({
  define: { __TOWER_FRONTEND_SOURCE_REV__: JSON.stringify(frontendSourceRev) },
  plugins: [
    malformedPathGuard(),
    {
      name: 'tower-frontend-release',
      generateBundle() {
        // Use the exact same value as the compiled JS, never runtime metadata.
        this.emitFile({
          type: 'asset',
          fileName: 'frontend-release.json',
          source: JSON.stringify({ sourceRev: frontendSourceRev }),
        });
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png', 'push-handlers.js'],
      manifest: {
        name: 'Tower',
        short_name: 'Tower',
        description: 'Stack your own tower of AI and systems.',
        theme_color: '#0d9488',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['productivity', 'business'],
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MiB
        // Critical for upgrades: workbox default leaves old precache caches in
        // place (workbox-precache-v1, workbox-precache-v2, …) until the SW is
        // explicitly reinstalled. On iOS Safari/WebKit the per-origin Cache
        // API quota is small (~50MB), so a chain of old 10MB precaches piles
        // up and eventually causes new SW install() to fail with QuotaExceeded
        // — the user's tab then gets STUCK on whatever cached SW happened to
        // win, and new builds (including our shrunk-precache fix) never take
        // effect. cleanupOutdatedCaches:true tells workbox-precaching to drop
        // every old precache cache during activate(), which is the correct
        // workbox-recommended setting and should have been on from day one.
        cleanupOutdatedCaches: true,
        // Precache strategy — minimize SW install cost.
        //
        // Symptom we saw: iOS Chrome (WKWebView) hangs on the static "Tower /
        // Loading…" fallback in index.html while SW install downloads ~10MB
        // of precache. User reload eventually unblocks because SW is finally
        // active. Pattern: matrix-style precache list (118 entries) blocks
        // first navigation on cold mobile networks.
        //
        // Fix: precache ONLY the static asset shell (CSS, icons, fonts).
        // ALL JS goes through runtimeCaching → first fetch hits network,
        // subsequent visits hit cache, SW install no longer races with the
        // initial bundle download. Net effect: precache ~10MB → ~200KB.
        // Trade-off: first visit after a deploy is slightly slower for the
        // *next* JS chunk fetch (it has to actually go to network), but
        // there's no install-storm anymore.
        globPatterns: ['**/*.{css,ico,png,svg,woff2}'],
        globIgnores: [
          // Heavy decorative images — load on demand, not in SW install.
          // tower-bg.png is ~1.5MB and ships as both /tower-bg.png and
          // /assets/tower-bg-*.png (Vite duplicates it during the asset
          // pipeline). favicon-gen.png is a 250KB intermediate icon.
          '**/tower-bg*.png',
          '**/favicon-gen*.png',
        ],
        // skipWaiting + clientsClaim: new SW takes over the active tab on the
        // very next navigation instead of waiting for every old tab to close.
        // Without these, a fresh deploy keeps serving the previous bundle to
        // any user who happened to keep Tower open — this surfaced as "Hub
        // still sends me to the wildcard subdomain URL" after the role-based
        // URL fix shipped. See workspace/decisions/2026-04-23-publishing-
        // visibility-redesign.md.
        skipWaiting: true,
        clientsClaim: true,
        // index.html is deliberately NOT precached (the server must serve the
        // latest document on every navigation). Workbox's NavigationRoute
        // requires its fallback to be precached; pointing it at index.html
        // while globPatterns excludes HTML makes the worker fail to install.
        // Let the server's SPA fallback handle navigations instead.
        navigateFallback: null,
        importScripts: ['/push-handlers.js'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // ALL same-origin /assets/*.js — main entry + vendor chunks +
            // lazy visual chunks. Use NetworkFirst rather than
            // StaleWhileRevalidate: a stale cached entrypoint can reference a
            // lazy chunk hash that was never cached and was deleted by the
            // latest deploy, producing the mobile/PWA "Chat error" screen.
            // NetworkFirst keeps repeat visits cached as a fallback but always
            // prefers the currently deployed JS graph when online.
            urlPattern: /\/assets\/.*\.js$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'js-runtime-cache',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  root: 'packages/frontend',
  // Concurrent dev/visual servers must not overwrite each other's optimized
  // React graph (production and development React cannot share a dispatcher).
  cacheDir: path.resolve(__dirname, `node_modules/.vite-tower/${process.pid}`),
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, 'packages/frontend/src'),
      '@tower/shared': path.resolve(__dirname, 'packages/shared/index.ts'),
    },
  },
  server: {
    port: 32354,
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/workspace/**',
        '**/data/**',
        '**/uploads/**',
        '**/.pm2/**',
        '**/.claude.json',
        '**/.pi/**',
        '**/.temp/**',
        '**/.tmp/**',
        '**/tmp/**',
      ],
    },
    proxy: {
      '/api': 'http://localhost:32355',
      '/ws': {
        target: 'ws://localhost:32355',
        ws: true,
      },
      '/sites': 'http://localhost:80',
    },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep only shell-critical libraries eager. Feature vendors follow
          // their lazy import graph so Mermaid, editors, and charts are not
          // module-preloaded for ordinary chat sessions.
          if (id.includes('/node_modules/@dnd-kit/')) return 'vendor-dnd';
          if (id.includes('/node_modules/katex/') || id.includes('/node_modules/rehype-katex/') || id.includes('/node_modules/remark-math/')) return 'vendor-katex';
          return undefined;
        },
      },
    },
  },
});
