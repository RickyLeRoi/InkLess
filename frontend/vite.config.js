// frontend/vite.config.js

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Keeps the browser on a single origin in development, so the API calls in
    // src/api.js stay relative and no CORS setup is needed locally.
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  build: {
    outDir: 'dist',
    // 20260831 ** RG #no_sourcemaps_in_production
    // nginx serves whatever lands in dist/, so `true` published the readable sources
    // next to the bundle. Switch to 'hidden' the day an error tracker needs them.
    sourcemap: false
  }
});
