import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
export default defineConfig({
  root: path.resolve(__dirname, '../../..'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@tower/shared': path.resolve(__dirname, '../../../packages/shared/index.ts') } },
  server: { host: '127.0.0.1', port: 32456, strictPort: true, watch: { ignored: ['**/work/**', '**/node_modules/**', '**/dist/**', '**/data/**', '**/.git/**'] } },
});
