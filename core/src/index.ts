import fastify from 'fastify';
import path from 'path';
import { Command } from 'commander';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { FileSystem } from './filesystem/FileSystem.js';
import { ProfileManager } from './filesystem/ProfileManager.js';
import { PluginManager } from './filesystem/PluginManager.js';
import { PluginOrchestrator } from './plugins/containers/PluginOrchestrator.js';
import { setGlobalLogger, getLogger } from './utils/logger.js';
import {
  openBrowser,
  getVersion,
  isGitRepository,
  checkDockerAvailability,
} from './utils/startup.js';
import { registerApi } from './api/index.js';
import { StaticAssetHandler } from './assets/StaticAssetHandler.js';

async function ignite(workspacePath: string): Promise<{
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

  // Initialize filesystem infrastructure
  app.log.info('🔧 Initializing Ignite...');
  const fileSystem = FileSystem.getInstance();
  const profileManager = await ProfileManager.getInstance();
  const pluginManager = PluginManager.getInstance();
  const pluginOrchestrator = PluginOrchestrator.getInstance();

  // Pre-startup checks
  app.log.info(`🔍 Workspace path: ${workspacePath}`);

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

  // Register API documentation and schemas
  await registerApi(app);

  return {
    app,
    fileSystem,
    profileManager,
    pluginManager,
    pluginOrchestrator,
  };
}

// Parse CLI arguments and perform pre-startup checks
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

  // Extract and validate workspace path
  const currentEnv = process.env.IGNITE_WORKSPACE_PATH;
  const workspacePath = path.resolve(currentEnv || options.path); // prefer env var if set
  process.env.IGNITE_WORKSPACE_PATH = workspacePath;

  // Check if workspace is a git repository
  const isGitRepo = isGitRepository(workspacePath);
  if (!isGitRepo) {
    process.env.IGNITE_WORKSPACE_PATH = '';
    process.stdout.write(
      `⚠️ Skipping auto-mount for non-git directory: ${workspacePath}\n`
    );
    process.stdout.write(
      'Use --path to specify a git repository, or run from within a git repository\n\n'
    );
  }

  // Check Docker availability
  await checkDockerAvailability();

  try {
    // Initialize server with all components
    const {
      app,
      fileSystem,
      profileManager,
      pluginManager: _pluginManager,
      pluginOrchestrator,
    } = await ignite(workspacePath);
    const port = parseInt(process.env.PORT || '1301', 10);

    // Log the repository path we're working with
    app.log.info(`📁 Repository path: ${workspacePath}`);

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
}

main().catch((error) => {
  process.stderr.write(`❌ Failed to start Ignite: ${error}\n`);
  process.exit(1);
});
