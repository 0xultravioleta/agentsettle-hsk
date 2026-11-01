import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `pnpm web:dev` serves the UI on :5173 and proxies the API and Agent B to the demo server on :8402.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8402', '/task': 'http://127.0.0.1:8402' },
  },
});
