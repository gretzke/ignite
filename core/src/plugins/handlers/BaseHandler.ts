import Docker from 'dockerode';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import type { PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';

// Generic base handler for all plugin types
export abstract class BaseHandler<
  TOperations extends Record<string, { params: unknown; result: unknown }>,
> {
  protected docker = new Docker();
  protected pluginLoader = PluginAssetLoader.getInstance();
  protected pluginId: string;

  // Static property that each handler must define
  abstract readonly type: PluginType;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  // Get the name of the currently executing method for use as operation name
  // This allows method names to automatically match operation names
  protected getCurrentMethodName(): string {
    const stack = new Error().stack;
    if (!stack) return 'unknown';

    // Look through stack frames to find the handler method
    const lines = stack.split('\n');
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      // Look for handler class methods (not BaseHandler, PluginExecutor, etc.)
      if (line.includes('Handler.') && !line.includes('BaseHandler.')) {
        const match = line.match(/at \w*Handler\.(\w+)/);
        if (match && match[1] !== 'getCurrentMethodName') {
          return match[1];
        }
      }
    }

    // Fallback: look for any method that's not our utility methods
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/at (\w+)/);
      if (
        match &&
        !['getCurrentMethodName', 'executeOperation', 'execute'].includes(
          match[1]
        )
      ) {
        return match[1];
      }
    }

    return 'unknown';
  }

  // Generic method to execute any operation in container
  protected async executeOperation<K extends keyof TOperations>(
    operation: K,
    options: TOperations[K]['params'],
    containerName: string
  ): Promise<PluginResult<TOperations[K]['result']>> {
    const container = this.docker.getContainer(containerName);

    // Load and inject plugin JavaScript
    const pluginCode = await this.pluginLoader.loadPlugin(
      this.type,
      this.pluginId
    );

    // Execute operation in container with type-safe parameters
    const optionsJson = JSON.stringify(options);
    const cmd = ['node', '-e', pluginCode, String(operation), optionsJson];

    const exec = await container.exec({
      Cmd: cmd,
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
        let stderr = '';

        // Handle both stdout and stderr
        stream.on('data', (chunk) => {
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
            getLogger().info(
              `🔍 Plugin stdout (${this.pluginId}): "${output}"`
            );
            getLogger().info(
              `🔍 Plugin stderr (${this.pluginId}): "${stderr}"`
            );

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
      });
    });
  }
}
