import type { Duplex } from 'stream';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import { ContainerOrchestrator } from '../containers/ContainerOrchestrator.js';
import { getLogger } from '../../utils/logger.js';

// Utility class for executing plugin operations in containers
export class PluginExecutionUtils {
  private static pluginLoader = PluginAssetLoader.getInstance();
  private static containerOrchestrator = ContainerOrchestrator.getInstance();

  // Execute a plugin operation in a container
  static async executeOperation<TResult>(
    pluginType: PluginType,
    pluginId: string,
    operation: string,
    options: unknown,
    containerName: string
  ): Promise<PluginResponse<TResult>> {
    const container = this.containerOrchestrator.getContainer(containerName);

    // Load and inject plugin JavaScript
    const pluginCode = await this.pluginLoader.loadPlugin(pluginType, pluginId);

    // Execute operation in container with type-safe parameters
    const optionsJson = JSON.stringify(options);
    const cmd = ['node', '-e', pluginCode, String(operation), optionsJson];

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    return new Promise((resolve, reject) => {
      exec.start(
        { hijack: true },
        (err: Error | null, stream: Duplex | undefined) => {
          if (err) {
            reject(err);
            return;
          }

          if (!stream) {
            reject(new Error('No stream returned from container exec'));
            return;
          }

          let output = '';
          let stderr = '';

          // Handle both stdout and stderr
          stream.on('data', (chunk: Buffer) => {
            const data = chunk.toString();
            if (chunk[0] === 2) {
              // stderr stream
              stderr += data.slice(8); // Remove Docker stream header
            } else {
              // stdout stream
              output += data.slice(8); // Remove Docker stream header
            }
          });

          stream.on('end', () => {
            try {
              getLogger().info(`🔍 Plugin stdout (${pluginId}): "${output}"`);
              getLogger().info(`🔍 Plugin stderr (${pluginId}): "${stderr}"`);

              // Parse JSON response from plugin
              const jsonMatch = output.match(/\{.*\}/s);
              if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                resolve(result);
              } else {
                reject(
                  new Error(
                    `Invalid plugin output: stdout="${output}", stderr="${stderr}"`
                  )
                );
              }
            } catch (error) {
              reject(new Error(`Failed to parse plugin output: ${error}`));
            }
          });
        }
      );
    });
  }
}
