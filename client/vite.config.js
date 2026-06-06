import { defineConfig } from 'vite';

// The server bridge runs on port 7777 (HTTP + WS for patch/profiles + DMX stream).
// Proxy /patch.json, /profiles, and /ws through Vite during dev so the page can
// use same-origin URLs.
export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    proxy: {
      '/patch.json': 'http://localhost:7777',
      '/profiles':   'http://localhost:7777',
      '/models':     'http://localhost:7777',
      '/ws':         { target: 'ws://localhost:7777', ws: true, rewrite: (p) => p.replace(/^\/ws/, '') },
    },
  },
});
