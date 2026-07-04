import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import compression from 'vite-plugin-compression';

const frontendPort = Number(process.env.IGNITE_FRONTEND_PORT || 1302);
const corePort = Number(
  process.env.IGNITE_CORE_PORT || process.env.PORT || 1301
);
const coreTarget = `http://localhost:${corePort}`;

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
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: coreTarget,
        headers: {
          'x-ignite-token': process.env.IGNITE_DEV_TOKEN || 'dev',
        },
      },
      '/ws': {
        target: coreTarget,
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
