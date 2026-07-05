import { getLogger } from '../../utils/logger.js';
import type { PluginExecutor } from './PluginExecutor.js';
import type { PluginResponse } from '@ignite/plugin-types/types';

// High-level CLI-startup orchestration: mount the default workspace.
export async function setupDefaultWorkspace(
  executor: Pick<PluginExecutor, 'execute'>,
  workspacePath: string
): Promise<PluginResponse<{ containerName: string; workspacePath: string }>> {
  getLogger().info(`📁 Setting up default workspace: ${workspacePath}`);
  const result = await executor.execute('local-repo', 'mount', {
    hostPath: workspacePath,
    name: 'default-workspace',
  });
  if (result.success) {
    getLogger().info('✅ Default workspace setup completed');
  } else {
    getLogger().warn(`⚠️ Default workspace setup failed: ${result.error}`);
  }
  return result as PluginResponse<{
    containerName: string;
    workspacePath: string;
  }>;
}
