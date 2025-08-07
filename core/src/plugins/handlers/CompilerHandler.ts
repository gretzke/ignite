import type {
  ICompilerPlugin,
  CompilerOperations,
  DetectOptions,
  DetectionResult,
} from '@ignite/plugin-types/base/compiler';
import type { PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import { BaseHandler } from './BaseHandler.js';

export class CompilerHandler
  extends BaseHandler<CompilerOperations>
  implements ICompilerPlugin
{
  public readonly type = PluginType.COMPILER as const;

  constructor(pluginId: string) {
    super(pluginId);
  }

  async detect(options: DetectOptions): Promise<PluginResult<DetectionResult>> {
    try {
      getLogger().info(
        `🔍 ${this.pluginId}: Detecting framework in container: ${options.repoContainerName}`
      );
      // Use generic base handler method with auto-detected operation name
      const operationName = this.getCurrentMethodName();
      const result = await this.executeOperation(
        operationName as keyof CompilerOperations,
        options,
        options.repoContainerName
      );

      if (result.success && result.data) {
        getLogger().info(
          `✅ ${this.pluginId} detection: ${result.data.detected ? 'found' : 'not found'}`
        );
      }

      return result;
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId} detection failed:`, error);
      return {
        success: false,
        error: String(error),
      };
    }
  }
}
