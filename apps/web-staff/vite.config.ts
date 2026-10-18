import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Two entries: the staff app (index.html) and the light Kiosk TV page (kiosk.html).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        kiosk: fileURLToPath(new URL('kiosk.html', import.meta.url)),
      },
    },
  },
  server: {
    // Dev/preview, same origin so no CORS is needed. The more specific realtime prefix goes first:
    // the Realtime SSE Gateway (REALTIME_PROXY_TARGET, default 127.0.0.1:3300), then the core
    // services API (API_PROXY_TARGET, default 127.0.0.1:3000).
    proxy: {
      '/api/v1/realtime': process.env.REALTIME_PROXY_TARGET ?? 'http://127.0.0.1:3300',
      '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
    },
  },
});
