import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.js: the dev/build config's proxy/manualChunks
// setup has no meaning under Vitest and loads env files we don't want here.
// Only exercises client-side hook/component tests written with
// @testing-library/react; server-side tests keep using the existing
// `node:test` + tsx convention (see e.g. server/modules/database/tests).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
});
