import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@memoriahub/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 5173,
    host: true, // Listen on all interfaces for Docker
    proxy: {
      // Proxy API requests to backend during development
      // Use 'api' for Docker container networking, fallback to localhost for local dev
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://api:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
