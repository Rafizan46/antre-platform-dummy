import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Two entries: the dashboard (index.html) and the light Kiosk TV page (kiosk.html).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        kiosk: fileURLToPath(new URL('kiosk.html', import.meta.url)),
      },
    },
  },
  server: {
    // Dev: the Realtime SSE Gateway (pnpm --filter @antre/realtime-gateway dev), same origin so no
    // CORS is needed; REALTIME_PROXY_TARGET overrides the default 127.0.0.1:3300.
    proxy: { '/api/v1/realtime': process.env.REALTIME_PROXY_TARGET ?? 'http://127.0.0.1:3300' },
  },
});
