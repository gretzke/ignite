import { getLogger } from '../../utils/logger.js';
import { PluginExecutor } from './PluginExecutor.js';
import type { PluginResult } from '@ignite/plugin-types/types';

// Orchestrates plugin workflows with dependency resolution
export class PluginOrchestrator {
  private static instance: PluginOrchestrator;
  private executor: PluginExecutor;

  private constructor() {
    this.executor = PluginExecutor.getInstance();
  }

  // Get singleton instance of PluginOrchestrator
  static getInstance(): PluginOrchestrator {
    if (!PluginOrchestrator.instance) {
      PluginOrchestrator.instance = new PluginOrchestrator();
    }
    return PluginOrchestrator.instance;
  }

  // Execute a single plugin (simple case)
  async executePlugin(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    return this.executor.execute(pluginId, operation, options);
  }

  // Set up default workspace - high-level orchestration for CLI startup
  async setupDefaultWorkspace(
    workspacePath: string
  ): Promise<PluginResult<{ containerName: string; workspacePath: string }>> {
    getLogger().info(`📁 Setting up default workspace: ${workspacePath}`);

    const result = await this.executePlugin('local-repo', 'mount', {
      hostPath: workspacePath,
      name: 'default-workspace',
    });

    if (result.success) {
      getLogger().info('✅ Default workspace setup completed');
    } else {
      getLogger().warn(`⚠️ Default workspace setup failed: ${result.error}`);
    }

    return result as PluginResult<{
      containerName: string;
      workspacePath: string;
    }>;
  }

  // Workflow orchestration is removed for now (unused)

  async cleanup(): Promise<void> {
    await this.executor.cleanup();
  }
}
