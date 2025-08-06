import Docker from 'dockerode';
import { promises as fs } from 'fs';
import { getLogger } from '../../utils/logger.js';
import { PluginAssetLoader } from '../../utils/PluginAssetLoader.js';
import { ContainerTracker } from './ContainerTracker.js';
import type { PluginMetadata, PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import type { LocalRepoOptions } from '../../types/index.js';

// Minimal plugin metadata for MVP
const PLUGIN_METADATA: Record<string, PluginMetadata> = {
  'local-repo': {
    id: 'local-repo',
    type: PluginType.REPO_MANAGER,
    name: 'Local Repository Manager',
    version: '1.0.0',
    baseImage: 'ignite/shared-repo-manager:latest',
  },
  foundry: {
    id: 'foundry',
    type: PluginType.COMPILER,
    name: 'Foundry Compiler',
    version: '1.0.0',
    baseImage: 'ignite/shared-compiler:latest',
  },
};

// Unified plugin executor - handles both volumes and containers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private docker = new Docker();
  private containerTracker = new ContainerTracker();
  private pluginLoader = PluginAssetLoader.getInstance();
  private initialized = false;

  private constructor() {}

  /**
   * Get singleton instance of PluginExecutor
   */
  static getInstance(): PluginExecutor {
    if (!PluginExecutor.instance) {
      PluginExecutor.instance = new PluginExecutor();
    }
    return PluginExecutor.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      getLogger().debug('Plugin Executor already initialized');
      return;
    }

    getLogger().info('🔧 Initializing Plugin Executor...');

    this.initialized = true;
    getLogger().info('✅ Plugin Executor initialized');
  }

  // Execute a single plugin operation
  async execute(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    const plugin = PLUGIN_METADATA[pluginId];
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }

    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    switch (plugin.type) {
      case 'repo-manager':
        return this.executeRepoManager(plugin, operation, options);
      case 'compiler':
        return this.executeCompiler(plugin, operation, options);
      default:
        throw new Error(`Unknown plugin type: ${plugin.type}`);
    }
  }

  // Repo manager operations (volume creation)
  private async executeRepoManager(
    plugin: PluginMetadata,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    switch (operation) {
      case 'mount':
        // Type check options for LocalRepoOptions
        if (
          !options.hostPath ||
          typeof options.hostPath !== 'string' ||
          !options.name ||
          typeof options.name !== 'string'
        ) {
          return {
            success: false,
            error:
              'Invalid options: hostPath and name are required for local repo mount',
          };
        }
        return this.createLocalRepoVolume(
          options as unknown as LocalRepoOptions
        );
      default:
        throw new Error(`Unknown repo manager operation: ${operation}`);
    }
  }

  // Compiler operations (compilation with volume mounting)
  private async executeCompiler(
    plugin: PluginMetadata,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    switch (operation) {
      case 'detect':
      case 'compile':
        return this.runCompilerInContainer(plugin, operation, options);
      default:
        throw new Error(`Unknown compiler operation: ${operation}`);
    }
  }

  // Create local repo container with volume mount
  private async createLocalRepoVolume(
    options: LocalRepoOptions
  ): Promise<PluginResult<unknown>> {
    const containerName = `ignite-repo-local-${options.name}`;

    getLogger().info(
      `📁 Creating local repo container: ${containerName} -> ${options.hostPath}`
    );

    // Verify the host path exists
    try {
      await fs.access(options.hostPath);
    } catch {
      return {
        success: false,
        error: `Local path does not exist: ${options.hostPath}`,
      };
    }

    // Create local repo container with bind mount
    const container = await this.docker.createContainer({
      Image: 'ignite/local-repo:latest',
      name: containerName,
      HostConfig: {
        Binds: [`${options.hostPath}:/workspace`],
        AutoRemove: false, // Keep container alive to maintain volume
      },
      WorkingDir: '/workspace',
      Env: [`WORKSPACE_PATH=/workspace`],
      Cmd: ['sleep', 'infinity'], // Keep container running
    });

    await container.start();

    // Track the container for lifecycle management
    this.containerTracker.track(container.id);

    getLogger().info(`✅ Local repo container created: ${containerName}`);

    return {
      success: true,
      data: { containerName, workspacePath: '/workspace' },
    };
  }

  // Run compiler in container (from PluginContainerManager)
  private async runCompilerInContainer(
    plugin: PluginMetadata,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    const { repoContainerName, workspacePath } = options;

    // Create container with volume mounted from repo container
    const container = await this.docker.createContainer({
      Image: plugin.baseImage,
      HostConfig: {
        AutoRemove: false, // Keep container for reuse, stop instead of remove
        VolumesFrom: repoContainerName ? [repoContainerName] : [],
      },
      WorkingDir: '/plugin',
      Env: [`WORKSPACE_PATH=${workspacePath || '/workspace'}`],
    });

    await container.start();

    // Track the container for lifecycle management
    this.containerTracker.track(container.id);

    // Get plugin JS and inject it
    const pluginJS = await this.getPluginCode(plugin.id);
    const escapedContent = pluginJS.replace(/'/g, "'\\''");

    const writeExec = await container.exec({
      Cmd: ['sh', '-c', `echo '${escapedContent}' > /plugin/index.js`],
      AttachStdout: true,
      AttachStderr: true,
    });
    await writeExec.start({ Detach: false });

    // Execute the plugin
    const pluginExec = await container.exec({
      Cmd: ['node', '/plugin/index.js'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await pluginExec.start({ Detach: false });

    // Parse result
    return new Promise((resolve, reject) => {
      let rawOutput = '';

      stream.on('data', (chunk: Buffer) => {
        rawOutput += chunk.toString('utf8');
      });

      stream.on('end', async () => {
        try {
          // Clean and parse output - remove control characters and quotes
          const cleanOutput = rawOutput
            .split('')
            .filter((char) => {
              const code = char.charCodeAt(0);
              return code >= 32 && code <= 126; // Keep only printable ASCII characters
            })
            .join('')
            .replace(/'/g, '')
            .trim();
          const output = cleanOutput;

          const jsonMatch = output.match(/\{.*\}/s);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            getLogger().info(`✅ Plugin ${plugin.id}.${operation} completed`);
            resolve(result);
          } else {
            resolve({
              success: false,
              error: `Invalid plugin output: ${output}`,
            });
          }
        } catch (error) {
          resolve({
            success: false,
            error: `Failed to parse plugin output: ${error}`,
          });
        }
      });

      stream.on('error', reject);
    });
  }

  // Get plugin code using unified AssetManager
  private async getPluginCode(pluginId: string): Promise<string> {
    // Get plugin metadata to determine type
    const plugin = PLUGIN_METADATA[pluginId];
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }

    try {
      return await this.pluginLoader.loadPlugin(plugin.type, pluginId);
    } catch (error) {
      throw new Error(`Failed to load plugin ${pluginId}: ${error}`);
    }
  }

  // Cleanup
  async cleanup(): Promise<void> {
    getLogger().info('🧹 Cleaning up Plugin Executor...');

    // Stop tracked containers (but don't remove them)
    await this.containerTracker.cleanup();

    this.initialized = false;
    getLogger().info('✅ Plugin Executor cleanup completed');
  }
}
