import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_ORIGIN ?? 'http://localhost:8080';

// In local mode the browser sees one origin (this dev server). The API is reached through the proxy,
// so cookies and the OIDC redirect work the same way as behind the load balancer on AWS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': api,
      '/auth': api,
      '/admin': api,
      '/mcp': api,
      '/healthz': api,
      '/readyz': api,
    },
  },
});
