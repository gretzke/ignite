import { getLogger } from '../../utils/logger.js';
import {
  PluginRegistryLoader,
  PluginLifecycle,
  PluginConfig,
} from '../../assets/PluginRegistryLoader.js';
import {
  ContainerOrchestrator,
  ContainerLifecycle,
} from './ContainerOrchestrator.js';
import {
  RepoContainerKind,
  RepoContainerUtils,
} from '../utils/RepoContainerUtils.js';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginExecutionUtils } from '../utils/PluginExecutionUtils.js';
import { hashWorkspacePath } from '../../utils/startup.js';

// Persistent Plugin Lifecycle (repo plugins):
// - Long-lived containers (AutoRemove=false)
// - Exception: Session containers (current IGNITE_WORKSPACE_PATH) are removed on shutdown
// - Regular containers are stopped (not removed) on shutdown for data persistence
//
// Ephemeral Plugin Lifecycle (processing plugins):
// - Short-lived containers (AutoRemove=true)
// - Created with VolumesFrom=[repoContainer] when requiresRepo=true
// - Automatically removed after operation completion

// Unified plugin executor - delegates to dynamic handlers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private containerOrchestrator = ContainerOrchestrator.getInstance();
  private registryLoader = PluginRegistryLoader.getInstance();

  private constructor() {}

  // Get singleton instance of PluginExecutor
  static getInstance(): PluginExecutor {
    if (!PluginExecutor.instance) {
      PluginExecutor.instance = new PluginExecutor();
    }
    return PluginExecutor.instance;
  }

  // Execute a single plugin operation with lifecycle-based container management
  async execute(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResponse<unknown>> {
    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    try {
      // Get plugin config for type and lifecycle info
      const pluginConfig = await this.registryLoader.getPluginConfig(pluginId);
      const lifecycle = pluginConfig.lifecycle;

      getLogger().info(`🔄 Plugin ${pluginId} lifecycle: ${lifecycle}`);

      // Execute based on plugin lifecycle from metadata
      if (lifecycle === PluginLifecycle.PERSISTENT) {
        return await this.executePersistentPlugin(
          pluginConfig,
          operation,
          options
        );
      } else if (lifecycle === PluginLifecycle.EPHEMERAL) {
        return await this.executeEphemeralPlugin(
          pluginConfig,
          operation,
          options
        );
      } else {
        throw new Error(`Unsupported plugin lifecycle: ${lifecycle}`);
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PLUGIN_EXECUTION_FAILED',
          message: `Plugin execution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  // Execute persistent plugin - long-lived containers, tracked lifecycle
  private async executePersistentPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(
      `📁 Executing persistent plugin: ${pluginId}.${operation}`
    );

    // Extract pathOrUrl and resolve container for repo plugins
    const { pathOrUrl, ...cleanOptions } = this.extractPathInfo(options);
    const containerName = await this.resolveRepoContainer(pluginId, pathOrUrl);

    // Execute directly using PluginExecutionUtils
    return this.executeOperationDirect(
      pluginConfig,
      operation,
      cleanOptions,
      containerName
    );
  }

  // Execute ephemeral plugin - short-lived containers, auto-cleanup
  private async executeEphemeralPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(`⚡ Executing ephemeral plugin: ${pluginId}.${operation}`);

    // Create ephemeral container with repo dependency resolution
    const ephemeralContainer = await this.createEphemeralContainer(
      pluginConfig,
      options
    );

    try {
      // Execute with resolved ephemeral container
      const { ...cleanOptions } = this.extractPathInfo(options);
      const result = await this.executeOperationDirect(
        pluginConfig,
        operation,
        cleanOptions,
        ephemeralContainer
      );

      getLogger().info(
        `✅ Ephemeral plugin execution completed: ${pluginId}.${operation}`
      );

      return result;
    } catch (error) {
      getLogger().error(
        `❌ Ephemeral plugin execution failed: ${pluginId}.${operation} - ${error}`
      );
      throw error;
    }
    // Note: Container auto-removes due to AutoRemove=true, no manual cleanup needed
  }

  // Create ephemeral container with AutoRemove=true and VolumesFrom repo if needed
  private async createEphemeralContainer(
    pluginConfig: PluginConfig,
    options: Record<string, unknown>
  ): Promise<string> {
    const pluginId = pluginConfig.metadata.id;
    const timestamp = Date.now();
    const ephemeralContainerName = `ignite-ephemeral-${pluginId}-${timestamp}`;

    const labels: Record<string, string> = {
      'ignite.type': 'ephemeral',
      'ignite.plugin': pluginId,
      'ignite.image': pluginConfig.metadata.baseImage,
    };

    let volumesFrom: string[] | undefined;

    // Add VolumesFrom if repo dependency is required
    if (pluginConfig.requiresRepo) {
      const { pathOrUrl } = this.extractPathInfo(options);
      const repoContainer = await this.resolveRepoContainer(
        pluginConfig.metadata.id,
        pathOrUrl
      );
      volumesFrom = [repoContainer];
      labels['ignite.repoContainer'] = repoContainer;

      getLogger().info(
        `🔗 Ephemeral container will use volumes from: ${repoContainer}`
      );
    }

    return await this.containerOrchestrator.createContainer({
      image: pluginConfig.metadata.baseImage,
      name: ephemeralContainerName,
      lifecycle: ContainerLifecycle.EPHEMERAL,
      labels,
      volumesFrom,
    });
  }

  // Execute operation directly without handler - new handler-free approach
  private async executeOperationDirect(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    containerName: string
  ): Promise<PluginResponse<unknown>> {
    try {
      // Call PluginExecutionUtils directly - no handler needed
      return await PluginExecutionUtils.executeOperation(
        pluginConfig.metadata.type,
        pluginConfig.metadata.id,
        operation,
        options,
        containerName
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'OPERATION_EXECUTION_FAILED',
          message: `Operation execution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  // Extract pathOrUrl from options for container resolution
  private extractPathInfo(options: Record<string, unknown>): {
    pathOrUrl?: string;
    [key: string]: unknown;
  } {
    const { pathOrUrl, ...cleanOptions } = options;
    return { pathOrUrl: pathOrUrl as string | undefined, ...cleanOptions };
  }

  // Resolve repository container for persistent plugins
  private async resolveRepoContainer(
    pluginId: string,
    pathOrUrl?: string
  ): Promise<string> {
    if (!pathOrUrl) {
      throw new Error(
        `Repository path required for persistent plugin: ${pluginId}`
      );
    }

    const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
    const isSession = RepoContainerUtils.isSessionLocal(kind, pathOrUrl);
    const containerName = RepoContainerUtils.deriveRepoContainerName(
      kind,
      pathOrUrl
    );

    // Check if container already exists and is running
    const existingContainer =
      await this.containerOrchestrator.getRunningContainer(containerName);
    if (existingContainer) {
      return existingContainer;
    }

    // Try to start existing stopped container
    try {
      return await this.containerOrchestrator.startContainer(containerName);
    } catch {
      // Container doesn't exist, create new one
      const baseImage = 'ignite/base_repo-manager:latest';
      const labels: Record<string, string> = {
        'ignite.type': 'repo-manager',
        'ignite.repoKind': kind,
        'ignite.plugin': pluginId,
        'ignite.image': baseImage,
        'ignite.workspace': '/workspace',
        'ignite.repoId': hashWorkspacePath(pathOrUrl),
      };

      if (kind === RepoContainerKind.LOCAL) {
        labels['ignite.sourcePath'] = pathOrUrl;
      } else {
        labels['ignite.sourceUrl'] = pathOrUrl;
      }

      const binds =
        kind === RepoContainerKind.LOCAL
          ? [`${pathOrUrl}:/workspace`]
          : undefined;
      const lifecycle = isSession
        ? ContainerLifecycle.SESSION
        : ContainerLifecycle.PERSISTENT;

      return await this.containerOrchestrator.createContainer({
        image: baseImage,
        name: containerName,
        lifecycle,
        labels,
        binds,
      });
    }
  }

  // Cleanup
  async cleanup(): Promise<void> {
    getLogger().info('🧹 Cleaning up Plugin Executor...');

    // ContainerOrchestrator handles all container lifecycle management
    await this.containerOrchestrator.cleanup();

    getLogger().info('✅ Plugin Executor cleanup completed');
  }
}
