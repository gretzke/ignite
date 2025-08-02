import Docker from 'dockerode';
import { promises as fs } from 'fs';
import { getLogger } from '../utils/logger.js';
import { PluginAssetLoader } from '../utils/PluginAssetLoader.js';
import type { PluginMetadata, StepResult } from '../types/plugins.js';
import type { LocalRepoOptions } from '../types/index.js';

// Minimal plugin metadata for MVP
const PLUGIN_METADATA: Record<string, PluginMetadata> = {
  'local-repo': {
    id: 'local-repo',
    type: 'repo-manager',
    baseImage: 'ignite/shared-repo-manager:latest',
  },
  foundry: {
    id: 'foundry',
    type: 'compiler',
    baseImage: 'ignite/shared-compiler:latest',
  },
};

// Unified plugin executor - handles both volumes and containers
export class PluginExecutor {
  private docker = new Docker();
  private volumes = new Map<string, any>();
  private containers = new Map<string, Docker.Container>();
  private readonly volumePrefix = 'ignite-repo';
  private pluginLoader = PluginAssetLoader.getInstance();

  async initialize(): Promise<void> {
    getLogger().info('🔧 Initializing Plugin Executor...');

    // Check if Docker is available
    await this.checkDockerAvailability();

    // Clean up orphaned volumes
    await this.cleanupOrphanedVolumes();

    getLogger().info('✅ Plugin Executor initialized');
  }

  // Execute a single plugin operation
  async execute(
    pluginId: string,
    operation: string,
    options: any
  ): Promise<StepResult> {
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
    options: any
  ): Promise<StepResult> {
    switch (operation) {
      case 'mount':
        return this.createLocalRepoVolume(options as LocalRepoOptions);
      default:
        throw new Error(`Unknown repo manager operation: ${operation}`);
    }
  }

  // Compiler operations (compilation with volume mounting)
  private async executeCompiler(
    plugin: PluginMetadata,
    operation: string,
    options: any
  ): Promise<StepResult> {
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
  ): Promise<StepResult> {
    const containerName = this.generateVolumeName('local', options.name);

    getLogger().info(
      `📁 Creating local repo container: ${containerName} -> ${options.hostPath}`
    );

    // Verify the host path exists
    try {
      await fs.access(options.hostPath);
    } catch (error) {
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

    // Track the container
    this.volumes.set(containerName, {
      volumeName: containerName,
      type: 'local',
      hostPath: options.hostPath,
      created: new Date().toISOString(),
    });

    getLogger().info(`✅ Local repo container created: ${containerName}`);

    return {
      success: true,
      data: { containerName },
      resources: {
        repoContainerName: containerName,
        workspacePath: '/workspace', // Path inside containers
      },
    };
  }

  // Run compiler in container (from PluginContainerManager)
  private async runCompilerInContainer(
    plugin: PluginMetadata,
    operation: string,
    options: any
  ): Promise<StepResult> {
    const { repoContainerName, workspacePath } = options;

    // Create container with volume mounted from repo container
    const container = await this.docker.createContainer({
      Image: plugin.baseImage,
      HostConfig: {
        AutoRemove: true,
        VolumesFrom: repoContainerName ? [repoContainerName] : [],
      },
      WorkingDir: '/plugin',
      Env: [`WORKSPACE_PATH=${workspacePath || '/workspace'}`],
    });

    await container.start();

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
          // Clean and parse output
          let output = rawOutput
            .replace(/[\x00-\x1F]/g, '')
            .replace(/'/g, '')
            .trim();

          const jsonMatch = output.match(/\{.*\}/s);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            getLogger().info(`✅ Plugin ${plugin.id}.${operation} completed`);

            resolve({
              success: true,
              data: result,
              resources: { artifacts: result },
            });
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

  // Check if Docker is available and running
  private async checkDockerAvailability(): Promise<void> {
    try {
      getLogger().info('🐳 Checking Docker availability...');

      // Try to ping Docker daemon
      const info = await this.docker.ping();

      getLogger().info('✅ Docker is available and running');
    } catch (error) {
      const errorMessage = `
🚨 Docker Error: Docker is not available or not running!

Please ensure Docker is installed and running:
  • Start Docker Desktop (if using macOS/Windows)
  • Or start Docker daemon (if using Linux)
  • Run 'docker ps' to verify Docker is working

Error details: ${error instanceof Error ? error.message : String(error)}
      `.trim();

      // Write error to stderr for better visibility
      process.stderr.write(errorMessage);
      throw new Error(
        'Docker is not available. Please start Docker and try again.'
      );
    }
  }

  // Helper methods
  private generateVolumeName(
    type: 'local' | 'cloned',
    customName?: string
  ): string {
    const timestamp = Date.now();
    const suffix = customName || `${timestamp}`;
    return `${this.volumePrefix}-${type}-${suffix}`;
  }

  private async cleanupOrphanedVolumes(): Promise<void> {
    try {
      const volumes = await this.docker.listVolumes();

      const igniteVolumes =
        volumes.Volumes?.filter(
          (vol) =>
            vol.Name.startsWith(this.volumePrefix) &&
            vol.Labels?.['ignite.type'] === 'repo'
        ) || [];

      if (igniteVolumes.length > 0) {
        getLogger().info(
          `🧹 Found ${igniteVolumes.length} orphaned repo volumes, cleaning up...`
        );

        for (const vol of igniteVolumes) {
          try {
            const volume = this.docker.getVolume(vol.Name);
            await volume.remove();
            getLogger().info(`🗑️  Removed orphaned volume: ${vol.Name}`);
          } catch (error) {
            getLogger().warn(
              `Failed to remove orphaned volume ${vol.Name}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      getLogger().warn('Failed to clean up orphaned volumes:', error);
    }
  }

  // Cleanup
  async cleanup(): Promise<void> {
    getLogger().info('🧹 Cleaning up Plugin Executor...');

    // Clean up volumes
    const volumeNames = Array.from(this.volumes.keys());
    for (const volumeName of volumeNames) {
      try {
        const volume = this.docker.getVolume(volumeName);
        await volume.remove();
        this.volumes.delete(volumeName);
      } catch (error) {
        getLogger().error(`Failed to remove volume ${volumeName}:`, error);
      }
    }

    getLogger().info('✅ Plugin Executor cleanup completed');
  }
}
