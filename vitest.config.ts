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
    ],
  },
});
