import fastify from 'fastify';
import path from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { FileSystem } from './filesystem/FileSystem.js';
import { ProfileManager } from './filesystem/ProfileManager.js';
import { PluginManager } from './filesystem/PluginManager.js';
import { PluginOrchestrator } from './containers/PluginOrchestrator.js';
import { setGlobalLogger } from './utils/logger.js';
import { openBrowser } from './utils/browser.js';
import { registerHealthRoutes } from './api/health.js';
import { registerProfileRoutes } from './api/profiles.js';
import { registerPluginRoutes } from './api/plugins.js';
import { StaticAssetHandler } from './utils/StaticAssetHandler.js';
import { readFileSync } from 'fs';

// Get version from package.json
const getVersion = (): string => {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const packageContent = readFileSync(packagePath, 'utf-8');
  const pkg = JSON.parse(packageContent);
  return pkg.version;
};

async function ignite(): Promise<{
  app: FastifyInstance;
  fileSystem: FileSystem;
  profileManager: ProfileManager;
  pluginManager: PluginManager;
  pluginOrchestrator: PluginOrchestrator;
}> {
  // Create Fastify instance - disable logger in production for clean output
  const app: FastifyInstance = fastify({
    logger: process.env.NODE_ENV === 'development',
  });

  // Set up global logger
  setGlobalLogger(app.log);

  // Log workspace path (now that logger is available)
  if (process.env.IGNITE_WORKSPACE_PATH) {
    app.log.info(
      `🔍 Using workspace path: ${process.env.IGNITE_WORKSPACE_PATH}`
    );
  }

  // Initialize filesystem infrastructure
  app.log.info('🔧 Initializing Ignite...');
  const fileSystem = new FileSystem();
  const profileManager = new ProfileManager(fileSystem);
  const pluginManager = new PluginManager(fileSystem);
  const pluginOrchestrator = new PluginOrchestrator();

  // Initialize components (will auto-create files as needed)
  await profileManager.initialize();

  // Initialize plugin orchestrator
  app.log.info('🔌 Setting up plugin orchestrator...');
  await pluginOrchestrator.initialize();

  // Auto-mount the workspace path (from commander --path argument)
  const workspacePath = process.env.IGNITE_WORKSPACE_PATH || process.cwd();

  // Safety check: don't auto-mount sensitive system directories
  const homePath = homedir();
  const documentsPath = path.join(homePath, 'Documents');
  const sensitiveDirectories = ['/', homePath, documentsPath];

  const shouldSkipMount = sensitiveDirectories.some(
    (dir) => path.resolve(workspacePath) === path.resolve(dir)
  );

  if (shouldSkipMount) {
    app.log.info(
      `⚠️ Skipping auto-mount for sensitive directory: ${workspacePath}`
    );
    app.log.info(
      '💡 Use --path to specify a project directory, or run from within a project'
    );
  } else {
    app.log.info(`📁 Auto-mounting workspace: ${workspacePath}`);

    try {
      await pluginOrchestrator.executePlugin('local-repo', 'mount', {
        hostPath: workspacePath,
        name: 'default-workspace',
      });
      app.log.info('✅ Default workspace mounted successfully');
    } catch (error) {
      app.log.warn(`⚠️ Failed to mount default workspace: ${error}`);
    }
  }

  // Register WebSocket plugin
  await app.register(websocket);

  // Register static asset handler for serving frontend from bundled assets
  await StaticAssetHandler.register(app);

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

  // Register API routes
  await registerHealthRoutes(app);
  await registerProfileRoutes(app, profileManager);
  await registerPluginRoutes(app, pluginManager, pluginOrchestrator);

  // Filesystem info routes
  app.get('/api/system/info', async () => {
    return {
      igniteHome: fileSystem.getIgniteHome(),
      currentProfile: profileManager.getCurrentProfile(),
      profilePaths: profileManager.getCurrentProfilePaths(),
    };
  });

  return {
    app,
    fileSystem,
    profileManager,
    pluginManager,
    pluginOrchestrator,
  };
}

const start = async (): Promise<void> => {
  try {
    // Initialize server with all components
    const {
      app,
      fileSystem,
      profileManager,
      pluginManager: _pluginManager,
      pluginOrchestrator,
    } = await ignite();
    const port = parseInt(process.env.PORT || '3000', 10);

    // Log the repository path we're working with
    app.log.info(
      `📁 Repository path: ${process.env.IGNITE_WORKSPACE_PATH || process.cwd()}`
    );

    // Listen on localhost only for security
    await app.listen({ port, host: '127.0.0.1' });

    // User-facing message - direct to stdout for visibility
    process.stdout.write(
      `\n🚀 Ignite server listening on http://localhost:${port}\n\n`
    );
    app.log.info(`📂 Current profile: ${profileManager.getCurrentProfile()}`);
    app.log.info(`📁 Ignite home: ${fileSystem.getIgniteHome()}`);

    // Open browser by default (CLI usage) unless explicitly disabled in development
    if (process.env.NODE_ENV !== 'development') {
      const frontendUrl = `http://localhost:${port}`;
      openBrowser(frontendUrl);
    }

    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      app.log.info('🛑 Shutting down gracefully...');
      try {
        await pluginOrchestrator.cleanup();
        await app.close();
        process.exit(0);
      } catch (error) {
        app.log.error(`Error during shutdown: ${error}`);
        process.exit(1);
      }
    });

    process.on('SIGTERM', async () => {
      app.log.info('🛑 Received SIGTERM, shutting down...');
      try {
        await pluginOrchestrator.cleanup();
        await app.close();
        process.exit(0);
      } catch (error) {
        app.log.error(`Error during shutdown: ${error}`);
        process.exit(1);
      }
    });
  } catch (err) {
    process.stderr.write(`❌ Failed to start Ignite: ${err}\n`);
    process.exit(1);
  }
};

// Parse CLI arguments and start server
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('ignite')
    .description('Smart contract deployment tool')
    .version(getVersion())
    .option(
      '-p, --path <path>',
      'specify workspace path (defaults to current directory)',
      process.cwd()
    )
    .parse();

  const options = program.opts();

  // Set the workspace path as an environment variable for the server to use
  process.env.IGNITE_WORKSPACE_PATH = path.resolve(options.path);

  // Start server
  await start();
}

main().catch((error) => {
  process.stderr.write(`❌ Failed to start Ignite: ${error}\n`);
  process.exit(1);
});
