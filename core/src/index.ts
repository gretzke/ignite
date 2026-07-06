import fastify from 'fastify';
import path from 'path';
import { setTimeout } from 'node:timers';
import { Command } from 'commander';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { FileSystem } from './filesystem/FileSystem.js';
import { ProfileManager } from './filesystem/ProfileManager.js';
import { PluginManager } from './filesystem/PluginManager.js';
import { PluginExecutor } from './plugins/containers/PluginExecutor.js';
import { setGlobalLogger, getLogger } from './utils/logger.js';
import {
  openBrowser,
  getVersion,
  isGitRepository,
  checkDockerAvailability,
} from './utils/startup.js';
import { registerApi } from './api/index.js';
import { registerSessionAuth, resolveSessionToken } from './api/auth.js';
import { createWsHandler } from './api/ws.js';
import { StaticAssetHandler } from './assets/StaticAssetHandler.js';
import { validatePluginImages } from './plugins/utils/ImageValidator.js';
import { PluginRegistryLoader } from './assets/PluginRegistryLoader.js';
import { RepoLifecycle } from './repos/RepoLifecycle.js';
import { JobManager } from './jobs/JobManager.js';
import { runCommand } from './utils/runCommand.js';

// Best-effort cleanup of containers/volumes left behind by the pre-Phase-3
// containerized repo-manager tier (deleted architecture: repos now live on
// the host, managed by core's RepoService). Runs once at every startup;
// idempotent (no-op once the leftovers are gone) and never throws.
async function sweepLegacyRepoManagerResources(): Promise<void> {
  // Bound every docker call: this runs (awaited) before app.listen(), and the
  // try/catch only catches rejections — a hung docker CLI/daemon (a realistic
  // failure mode here, see docs/docker-desktop-vm-crashes.md) would otherwise
  // wedge startup forever. On timeout runCommand rejects, which the catch
  // below swallows with a warn (sweep is best-effort).
  const SWEEP_TIMEOUT_MS = 10_000;
  try {
    const containers = await runCommand(
      'docker',
      ['ps', '-aq', '--filter', 'label=ignite.type=repo-manager'],
      { timeoutMs: SWEEP_TIMEOUT_MS }
    );
    const containerIds = containers.stdout
      .split('\n')
      .map((id) => id.trim())
      .filter(Boolean);
    if (containerIds.length > 0) {
      await runCommand('docker', ['rm', '-f', ...containerIds], {
        timeoutMs: SWEEP_TIMEOUT_MS,
      });
    }

    const volumes = await runCommand(
      'docker',
      ['volume', 'ls', '-q', '--filter', 'name=ignite-cloned-'],
      { timeoutMs: SWEEP_TIMEOUT_MS }
    );
    const volumeNames = volumes.stdout
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    if (volumeNames.length > 0) {
      await runCommand('docker', ['volume', 'rm', '-f', ...volumeNames], {
        timeoutMs: SWEEP_TIMEOUT_MS,
      });
    }

    if (containerIds.length > 0 || volumeNames.length > 0) {
      getLogger().info(
        `🧹 Legacy sweep: removed ${containerIds.length} repo-manager container(s), ${volumeNames.length} cloned-repo volume(s)`
      );
    }
  } catch (error) {
    getLogger().warn(`⚠️ Legacy repo-manager sweep failed: ${error}`);
  }
}

async function ignite(workspacePath: string): Promise<{
  app: FastifyInstance;
  fileSystem: FileSystem;
  profileManager: ProfileManager;
  pluginManager: PluginManager;
  pluginExecutor: PluginExecutor;
  sessionToken: string;
}> {
  // Create Fastify instance - disable logger in production for clean output
  const app: FastifyInstance = fastify({
    logger: process.env.NODE_ENV === 'development' ? { level: 'debug' } : false,
  });

  // Set up global logger
  setGlobalLogger(app.log);

  // Session auth must be registered before all routes so its onRequest hook
  // guards every subsequently registered route, including /ws and the API.
  const sessionToken = resolveSessionToken();
  await registerSessionAuth(app, sessionToken);

  // Initialize filesystem infrastructure
  app.log.info('🔧 Initializing Ignite...');
  const fileSystem = FileSystem.getInstance();
  const profileManager = await ProfileManager.getInstance();
  const pluginManager = PluginManager.getInstance();
  const pluginExecutor = PluginExecutor.getInstance();
  await JobManager.getInstance().recover();

  // One-time legacy sweep: earlier Ignite versions ran a containerized
  // repo-manager tier (persistent containers + named clone volumes). Users
  // upgrading from that architecture may have leftovers on disk; best-effort
  // remove them so `docker ps -a` / `docker volume ls` stay clean. Never
  // fatal — a failure here must not block startup.
  await sweepLegacyRepoManagerResources();

  // Pre-startup checks
  app.log.info(`🔍 Workspace path: ${workspacePath}`);

  // Register WebSocket plugin
  await app.register(websocket);

  // Register static asset handler for serving frontend from bundled assets
  await StaticAssetHandler.register(app);

  // WebSocket route: job event channel (subscribe/unsubscribe, snapshot +
  // replay + live events). See api/ws.ts for the protocol.
  await app.register(async function (fastify: FastifyInstance) {
    fastify.get(
      '/ws',
      { websocket: true },
      createWsHandler(JobManager.getInstance())
    );
  });

  // Register API documentation and schemas
  await registerApi(app);

  return {
    app,
    fileSystem,
    profileManager,
    pluginManager,
    pluginExecutor,
    sessionToken,
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
    .option('--dev', 'run in development mode (sets NODE_ENV=development)')
    .parse();

  const options = program.opts();

  // Must happen before anything reads NODE_ENV (logger, auth token, home dir)
  if (options.dev) {
    process.env.NODE_ENV = 'development';
  }

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
      pluginExecutor,
      sessionToken,
    } = await ignite(workspacePath);

    // Fail fast on a missing/corrupt built-in plugin catalog: built-ins ship
    // with the binary, so an unloadable catalog is a broken installation.
    // Without this check the server comes up and every detect/compile quietly
    // reports "no frameworks" (the exact failure mode of running against a
    // tree whose plugin build artifacts were cleaned).
    await PluginRegistryLoader.getInstance().getAllPlugins();

    // Warn early about missing or stale plugin images
    await validatePluginImages();

    const port = parseInt(
      process.env.IGNITE_CORE_PORT || process.env.PORT || '1301',
      10
    );

    // Log the repository path we're working with
    app.log.info(`📁 Repository path: ${workspacePath}`);

    // Listen on localhost only; session auth protects /api and /ws even from
    // containers that reach us via host.docker.internal.
    await app.listen({ port, host: '127.0.0.1' });

    // Server-driven repo lifecycle: sweep the active profile once per CLI
    // run (init + detect + persist). The UI attaches to whatever is still
    // in flight via the jobs WS channel instead of re-running the cycle on
    // every page load.
    RepoLifecycle.getInstance().ensureProfileSwept(
      profileManager.getCurrentProfile()
    );

    const authedUrl = `http://localhost:${port}/?token=${sessionToken}`;

    // User-facing message - direct to stdout for visibility
    process.stdout.write(`\n🚀 Ignite server listening on ${authedUrl}\n\n`);
    app.log.info(`📂 Current profile: ${profileManager.getCurrentProfile()}`);
    app.log.info(`📁 Ignite home: ${fileSystem.getIgniteHome()}`);

    // Open browser by default (CLI usage) unless explicitly disabled in development
    if (process.env.NODE_ENV !== 'development') {
      openBrowser(authedUrl);
    }

    // Graceful shutdown handling. Container stops are handed to a detached
    // process so the CLI exits promptly instead of waiting out every stop
    // grace period; a second signal force-exits.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) {
        process.stdout.write('\n⚠️  Force exiting.\n');
        process.exit(130);
      }
      shuttingDown = true;
      process.stdout.write('\n👋 Exiting...\n');
      app.log.info(`🛑 Received ${signal}, shutting down...`);

      // unref'd so this timer never keeps the process alive on its own
      setTimeout(() => {
        process.stdout.write(
          'Still shutting down — press Ctrl+C again to force exit.\n'
        );
      }, 5000).unref();

      void (async () => {
        try {
          pluginExecutor.cleanupDetached();
          await app.close();
          process.exit(0);
        } catch (error) {
          app.log.error(`Error during shutdown: ${error}`);
          process.exit(1);
        }
      })();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    process.stderr.write(`❌ Failed to start Ignite: ${err}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`❌ Failed to start Ignite: ${error}\n`);
  process.exit(1);
});
