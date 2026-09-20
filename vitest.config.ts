import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': '"test"',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'packages/frontend/src'),
      '@tower/shared': path.resolve(__dirname, 'packages/shared/index.ts'),
      // `virtual:pwa-register` is a Vite virtual module supplied by
      // vite-plugin-pwa at build/dev time. Vitest doesn't load that plugin,
      // so we alias the import to a no-op stub for tests. Individual tests
      // can still override behavior with `vi.mock('virtual:pwa-register', ...)`.
      'virtual:pwa-register': path.resolve(
        __dirname,
        'packages/frontend/src/test-stubs/virtual-pwa-register.ts',
      ),
    },
  },
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['packages/frontend/**/*.test.{ts,tsx}', 'jsdom'],
      ['packages/backend/**/*.test.ts', 'node'],
    ],
    include: [
      'packages/backend/**/*.test.ts',
      'packages/frontend/**/*.test.{ts,tsx}',
      'packages/shared/**/*.test.ts',
      '__tests__/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '__tests__/build-smoke.test.ts',
      // Operator-only source contracts depend on deployment, cache, Git-hook,
      // private-skill, or checked-in sample assets intentionally absent from the
      // public repository. Keep OSS preflight scoped to artifacts it ships.
      'packages/backend/nix-cache-health-timer.source.test.ts',
      'packages/backend/nix-cache-health.source.test.ts',
      'packages/backend/nix-private-cache.source.test.ts',
      'packages/backend/nix-production-launcher.source.test.ts',
      'packages/backend/nix-signed-cache.source.test.ts',
      'packages/backend/operator-prod-upgrade-orchestrator.source.test.ts',
      'packages/backend/pre-push-verified-state.source.test.ts',
      'packages/backend/push-main-safe.source.test.ts',
      'packages/backend/db/migrations/channel-membership-migration-delivery.source.test.ts',
      'packages/backend/services/runtime-box/gws-skill-profile.source.test.ts',
      'packages/backend/services/workspace-apps/sample-app-smoke.test.ts',
    ],
  },
});
