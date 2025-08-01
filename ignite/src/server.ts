import fastify from 'fastify';
import path from 'path';
import { exec } from 'child_process';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { FileSystem } from './filesystem/FileSystem.js';
import { ProfileManager } from './filesystem/ProfileManager.js';
import { setGlobalLogger } from './utils/logger.js';

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

  // eslint-disable-next-line security/detect-child-process -- Safe: used only for opening browser
  exec(command);
}

async function ignite(): Promise<{
  app: FastifyInstance;
  fileSystem: FileSystem;
  profileManager: ProfileManager;
}> {
  // Create Fastify instance - disable logger in production for clean output
  const app: FastifyInstance = fastify({
    logger: process.env.NODE_ENV === 'development',
  });

  // Set up global logger
  setGlobalLogger(app.log);

  // Initialize filesystem infrastructure
  app.log.info('🔧 Initializing Ignite...');
  const fileSystem = new FileSystem();
  const profileManager = new ProfileManager(fileSystem);

  // Initialize profile manager (will auto-create files as needed)
  await profileManager.initialize();

  // Register WebSocket plugin
  await app.register(websocket);

  // Register static files plugin for serving frontend
  // Detect environment: pkg bundled (production) vs development
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pkg property not in Node.js types
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

  // API routes
  app.get('/api/hello', async () => {
    return { message: 'Hello from Ignite backend!' };
  });

  // Profile management routes
  app.get('/api/profiles', async () => {
    const profiles = await profileManager.listProfiles();
    return { profiles };
  });

  app.get('/api/profiles/current', async () => {
    const currentProfile = profileManager.getCurrentProfile();
    const config = await profileManager.getCurrentProfileConfig();
    return { name: currentProfile, config };
  });

  app.post('/api/profiles', async (request) => {
    const { name } = request.body as { name: string };

    if (!name || typeof name !== 'string') {
      throw new Error('Profile name is required');
    }

    await profileManager.createProfile(name);
    return { success: true, message: `Profile '${name}' created successfully` };
  });

  app.post('/api/profiles/switch', async (request) => {
    const { name } = request.body as { name: string };

    if (!name || typeof name !== 'string') {
      throw new Error('Profile name is required');
    }

    await profileManager.switchProfile(name);
    return { success: true, message: `Switched to profile '${name}'` };
  });

  // Filesystem info routes
  app.get('/api/system/info', async () => {
    return {
      igniteHome: fileSystem.getIgniteHome(),
      currentProfile: profileManager.getCurrentProfile(),
      profilePaths: profileManager.getCurrentProfilePaths(),
    };
  });

  // Fallback to serve index.html for SPA routing
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.sendFile('index.html');
  });

  return { app, fileSystem, profileManager };
}

const start = async (): Promise<void> => {
  try {
    // Initialize server with all components
    const { app, fileSystem, profileManager } = await ignite();
    const port = parseInt(process.env.PORT || '3000', 10);

    // Listen on localhost only for security
    await app.listen({ port, host: '127.0.0.1' });

    // User-facing message - direct to stdout for visibility
    process.stdout.write(
      `\n🚀 Ignite server listening on http://localhost:${port}\n`
    );
    app.log.info(`📂 Current profile: ${profileManager.getCurrentProfile()}`);
    app.log.info(`📁 Ignite home: ${fileSystem.getIgniteHome()}`);

    // Open browser by default (CLI usage) unless explicitly disabled in development
    if (process.env.NODE_ENV !== 'development') {
      const frontendUrl = `http://localhost:${port}`;
      openBrowser(frontendUrl);
    }
  } catch (err) {
    process.stderr.write(`❌ Failed to start Ignite: ${err}\n`);
    process.exit(1);
  }
};

start();
