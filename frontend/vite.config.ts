import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import compression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Generate gzipped versions of assets for pkg bundling
    compression({
      algorithm: 'gzip',
      ext: '.gz',
      deleteOriginFile: false, // Keep both original and compressed files
    }),
  ],
  server: {
    port: 1302,
    proxy: {
      '/api': {
        target: 'http://localhost:1301',
        headers: {
          'x-ignite-token': process.env.IGNITE_DEV_TOKEN || 'dev',
        },
      },
      '/ws': {
        target: 'http://localhost:1301',
        ws: true,
        headers: {
          'x-ignite-token': process.env.IGNITE_DEV_TOKEN || 'dev',
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  clearScreen: false,
});
