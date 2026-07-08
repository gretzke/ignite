import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import compression from 'vite-plugin-compression';

const frontendPort = Number(process.env.IGNITE_FRONTEND_PORT || 1302);
const corePort = Number(
  process.env.IGNITE_CORE_PORT || process.env.PORT || 1301
);
const coreTarget = `http://localhost:${corePort}`;

// Throttle ECONNREFUSED logs to once per 5 seconds
let lastEconnrefusedLogTime = 0;
const ECONNREFUSED_LOG_INTERVAL = 5000;

function createProxyErrorHandler(proxyName: string) {
  return (err: Error, _req: unknown, res: unknown) => {
    const errCode =
      (err as NodeJS.ErrnoException).code ||
      ('errors' in err && Array.isArray((err as any).errors)
        ? (err as any).errors[0]?.code
        : undefined);

    if (errCode === 'ECONNREFUSED') {
      const now = Date.now();
      if (now - lastEconnrefusedLogTime >= ECONNREFUSED_LOG_INTERVAL) {
        console.log('[vite] core not reachable yet (retrying)');
        lastEconnrefusedLogTime = now;
      }
      // Send 503 for HTTP requests if headers not sent yet
      if ('writeHead' in res) {
        const httpRes = res as any;
        if (!httpRes.headersSent) {
          httpRes.writeHead(503, { 'Content-Type': 'text/plain' });
          httpRes.end('Core service unavailable');
        }
      }
      // Suppress any further error handling
      return;
    } else {
      // Log other errors with code and message
      console.error(
        `[vite] ${proxyName} proxy error:`,
        errCode ? `${errCode} ${(err as NodeJS.ErrnoException).message}` : err.message
      );
    }
  };
}

export default defineConfig({
  plugins: [
    {
      name: 'suppress-proxy-econnrefused',
      apply: 'serve',
      configResolved() {
        // Wrap console.error to suppress proxy ECONNREFUSED stack traces
        const originalError = console.error;
        const suppressedErrors = new Set<Error>();

        console.error = function(...args: any[]) {
          // Check if this is the "http proxy error" message followed by an AggregateError
          if (args.length > 0 && args[0]?.toString().includes('http proxy error')) {
            // Check if there's an error object with ECONNREFUSED
            const hasEconnrefused = args.some((arg: any) => {
              if (arg instanceof Error) {
                return (
                  arg.code === 'ECONNREFUSED' ||
                  (arg.name === 'AggregateError' &&
                    'errors' in arg &&
                    Array.isArray((arg as any).errors) &&
                    (arg as any).errors.some((e: any) => e.code === 'ECONNREFUSED'))
                );
              }
              return arg.toString?.().includes('ECONNREFUSED');
            });

            if (hasEconnrefused) {
              // Suppress the error stack for ECONNREFUSED on proxy errors
              return;
            }
          }

          // Pass through all other errors
          originalError.apply(console, args);
        };
      },
    },
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
        configure: (proxy) => {
          // Suppress http-proxy's internal logging
          (proxy as any).logProvider = {
            log: () => {},
            warn: () => {},
            error: () => {},
          };
          proxy.on('error', createProxyErrorHandler('/api'));
        },
      },
      '/ws': {
        target: coreTarget,
        ws: true,
        headers: {
          'x-ignite-token': process.env.IGNITE_DEV_TOKEN || 'dev',
        },
        configure: (proxy) => {
          // Suppress http-proxy's internal logging
          (proxy as any).logProvider = {
            log: () => {},
            warn: () => {},
            error: () => {},
          };
          proxy.on('error', createProxyErrorHandler('/ws'));
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  clearScreen: false,
});
