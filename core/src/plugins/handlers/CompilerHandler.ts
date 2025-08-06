import type {
  ICompilerPlugin,
  DetectOptions,
  DetectionResult,
} from '@ignite/plugin-types/base/compiler';
import type { PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import { PluginAssetLoader } from '../../utils/PluginAssetLoader.js';

export class CompilerHandler implements ICompilerPlugin {
  public readonly type = PluginType.COMPILER as const;
  private docker = new Docker();
  private pluginLoader = PluginAssetLoader.getInstance();
  private readonly pluginId: string;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  async detect(options: DetectOptions): Promise<PluginResult<DetectionResult>> {
    try {
      getLogger().info(
        `🔍 ${this.pluginId}: Detecting framework in container: ${options.repoContainerName}`
      );

      // Run detection logic in container
      const result = await this.runDetectionInContainer(options);

      getLogger().info(
        `✅ ${this.pluginId} detection: ${result.detected ? 'found' : 'not found'}`
      );
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId} detection failed:`, error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  private async runDetectionInContainer(
    options: DetectOptions
  ): Promise<DetectionResult> {
    const container = this.docker.getContainer(options.repoContainerName);

    // Load and inject plugin JavaScript
    const pluginCode = await this.pluginLoader.loadPlugin(
      this.type,
      this.pluginId
    );

    // Execute detection in container
    const exec = await container.exec({
      Cmd: ['node', '-e', pluginCode],
      AttachStdout: true,
      AttachStderr: true,
    });

    return new Promise((resolve, reject) => {
      exec.start({ hijack: true }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        if (!stream) {
          reject(new Error('No stream returned from container exec'));
          return;
        }

        let output = '';
        stream.on('data', (chunk) => {
          output += chunk.toString();
        });

        stream.on('end', () => {
          try {
            // Parse JSON response from plugin
            const jsonMatch = output.match(/\{.*\}/s);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);
              resolve(result);
            } else {
              reject(new Error(`Invalid plugin output: ${output}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse plugin output: ${error}`));
          }
        });
      });
    });
  }
}
