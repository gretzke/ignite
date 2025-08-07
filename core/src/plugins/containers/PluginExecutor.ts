import { getLogger } from '../../utils/logger.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { ContainerTracker } from './ContainerTracker.js';
import { BaseHandler } from '../handlers/BaseHandler.js';
import { CompilerHandler } from '../handlers/CompilerHandler.js';
import { RepoManagerHandler } from '../handlers/RepoManagerHandler.js';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginResult } from '@ignite/plugin-types/types';

// Unified plugin executor - delegates to dynamic handlers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private containerTracker = ContainerTracker.getInstance();
  private registryLoader = PluginRegistryLoader.getInstance();

  private constructor() {}

  // Get singleton instance of PluginExecutor
  static getInstance(): PluginExecutor {
    if (!PluginExecutor.instance) {
      PluginExecutor.instance = new PluginExecutor();
    }
    return PluginExecutor.instance;
  }

  // Execute a single plugin operation with automatic container tracking
  async execute(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    try {
      // Get the appropriate handler and delegate execution
      const handler = await this.getHandler(pluginId);

      // Type-safe operation execution using the handler's built-in method dispatch
      const result = await this.executeOperation(handler, operation, options);

      // Automatic container tracking for any successful operation that creates containers
      if (result.success && result.data) {
        const data = result.data as { containerName?: string };
        if (data.containerName) {
          this.containerTracker.track(data.containerName);
          getLogger().info(`📝 Auto-tracking container: ${data.containerName}`);
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Plugin execution failed: ${error}`,
      };
    }
  }

  // Dynamic handler creation based on plugin metadata
  private async getHandler<
    T extends Record<string, { params: unknown; result: unknown }>,
  >(pluginId: string): Promise<BaseHandler<T>> {
    const pluginMetadata =
      await this.registryLoader.getPluginMetadata(pluginId);

    // Create handler based on plugin type (exhaustive checking)
    switch (pluginMetadata.type) {
      case PluginType.COMPILER:
        return new CompilerHandler(pluginId) as BaseHandler<T>;
      case PluginType.REPO_MANAGER:
        return new RepoManagerHandler(pluginId) as BaseHandler<T>;
      default: {
        // Exhaustive checking: this will cause a TypeScript error if we add new plugin types
        const _exhaustiveCheck: never = pluginMetadata.type;
        throw new Error(
          `Unsupported plugin type: ${_exhaustiveCheck} for plugin: ${pluginId}`
        );
      }
    }
  }

  // Generalized operation execution - works with any handler type
  // Uses reflection to call the appropriate method on the handler
  private async executeOperation<
    T extends Record<string, { params: unknown; result: unknown }>,
  >(
    handler: BaseHandler<T>,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    // Check if the handler has this operation method
    const method = (handler as unknown as Record<string, unknown>)[operation];

    if (typeof method !== 'function') {
      return {
        success: false,
        error: `Operation '${operation}' is not supported by this plugin type`,
      };
    }

    try {
      // Call the method with proper context
      const result = await (
        method as (...args: unknown[]) => Promise<PluginResult<unknown>>
      ).call(handler, options);
      return result;
    } catch (error) {
      return {
        success: false,
        error: `Operation execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Cleanup
  async cleanup(): Promise<void> {
    getLogger().info('🧹 Cleaning up Plugin Executor...');

    // Stop tracked containers (but don't remove them)
    await this.containerTracker.cleanup();

    getLogger().info('✅ Plugin Executor cleanup completed');
  }
}
