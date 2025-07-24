import fastify from 'fastify';
import path from 'path';
import { exec } from 'child_process';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Cross-platform browser opening function
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    // Linux and other Unix-like systems
    command = `xdg-open "${url}"`;
  }

  exec(command);
}

async function createServer(): Promise<FastifyInstance> {
  // Create Fastify instance - disable logger in production for clean output
  const app: FastifyInstance = fastify({
    logger: process.env.NODE_ENV === 'development',
  });

  // Register WebSocket plugin
  await app.register(websocket);

  // Register static files plugin for serving frontend
  // Detect environment: pkg bundled (production) vs development
  const isPkgBundled = typeof (process as any).pkg !== 'undefined';
  const frontendPath = path.resolve(
    isPkgBundled ? 'frontend/dist' : '../frontend/dist'
  );
  await app.register(staticFiles, {
    root: frontendPath,
    prefix: '/', // optional: default '/'
  });

  // WebSocket route
  await app.register(async function (fastify: FastifyInstance) {
    fastify.get('/ws', { websocket: true }, (connection) => {
      connection.on('message', (message: Buffer) => {
        // Echo back with a greeting
        connection.send(
          JSON.stringify({
            type: 'greeting',
            message: `Hello from backend! You said: ${message.toString()}`,
          })
        );
      });

      connection.on('close', () => {});

      // Send initial connection message
      connection.send(
        JSON.stringify({
          type: 'connected',
          message: 'Connected to Ignite backend!',
        })
      );
    });
  });

  // API route
  app.get('/api/hello', async () => {
    return { message: 'Hello from Ignite backend!' };
  });

  // Fallback to serve index.html for SPA routing
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.sendFile('index.html');
  });

  return app;
}

const start = async (): Promise<void> => {
  try {
    const app = await createServer();
    const port = parseInt(process.env.PORT || '3000', 10);
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 Ignite server listening on http://localhost:${port}\n`);

    // Open browser by default (CLI usage) unless explicitly disabled in development
    if (process.env.NODE_ENV !== 'development') {
      const frontendUrl = `http://localhost:${port}`;
      openBrowser(frontendUrl);
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
