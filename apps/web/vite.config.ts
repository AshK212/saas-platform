import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev server proxies `/v1/*` to the API so the browser sees a SINGLE ORIGIN.
 *
 * This matters for authentication: with one origin there is no CORS at all, and
 * the `SameSite=Lax` session cookie is sent normally. A cross-origin dev setup
 * would require `SameSite=None; Secure`, which cannot work over plain-HTTP
 * localhost - so the proxy keeps development faithful to the same-site
 * deployment we want in staging. See docs/authentication.md.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
