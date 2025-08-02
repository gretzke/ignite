import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import compression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    react(),
    // Generate gzipped versions of assets for pkg bundling
    compression({
      algorithm: 'gzip',
      ext: '.gz',
      deleteOriginFile: false, // Keep both original and compressed files
    }),
  ],
  server: {
    port: 3001,
  },
  build: {
    outDir: 'dist',
  },
});
