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
          // Buffer for robust Docker stream demultiplexing
          let muxBuffer: Buffer = Buffer.alloc(0);
          let multiplexingMode: 'unknown' | 'multiplexed' | 'raw' = 'unknown';

          // Handle both stdout and stderr with robust demultiplexing
          stream.on('data', (chunk: Buffer) => {
            // Accumulate chunks into buffer
            muxBuffer = Buffer.concat([muxBuffer, chunk]);

            // Decide mode if unknown and enough bytes
            if (multiplexingMode === 'unknown' && muxBuffer.length >= 8) {
              const looksLikeHeader =
                (muxBuffer[0] === 0 ||
                  muxBuffer[0] === 1 ||
                  muxBuffer[0] === 2) &&
                muxBuffer[1] === 0 &&
                muxBuffer[2] === 0 &&
                muxBuffer[3] === 0;
              multiplexingMode = looksLikeHeader ? 'multiplexed' : 'raw';
            }

            if (multiplexingMode === 'raw') {
              output += muxBuffer.toString('utf8');
              muxBuffer = Buffer.alloc(0);
              return;
            }

            // Parse multiplexed frames: [stream(1), 0,0,0, len(4), payload]
            while (muxBuffer.length >= 8) {
              const streamType = muxBuffer[0];
              const z1 = muxBuffer[1];
              const z2 = muxBuffer[2];
              const z3 = muxBuffer[3];
              const len = muxBuffer.readUInt32BE(4);

              const headerValid =
                (streamType === 0 || streamType === 1 || streamType === 2) &&
                z1 === 0 &&
                z2 === 0 &&
                z3 === 0;
              if (!headerValid) {
                // Fallback to raw mode to avoid corrupting payload
                multiplexingMode = 'raw';
                output += muxBuffer.toString('utf8');
                muxBuffer = Buffer.alloc(0);
                break;
              }

              if (muxBuffer.length < 8 + len) {
                // Wait for more data
                break;
              }

              const payload = muxBuffer.subarray(8, 8 + len);
              if (streamType === 2) {
                stderr += payload.toString('utf8');
              } else if (streamType === 1) {
                output += payload.toString('utf8');
              }
              // stdin (0) ignored

              muxBuffer = muxBuffer.subarray(8 + len);
            }
          });

          stream.on('end', () => {
            try {
              getLogger().info(`🔍 Plugin stdout (${pluginId}): "${output}"`);
              getLogger().info(`🔍 Plugin stderr (${pluginId}): "${stderr}"`);

              // Parse JSON response from plugin
              // Clean the output to remove any binary characters or control sequences
              const cleanOutput = output
                .split('')
                .filter((char) => {
                  const code = char.charCodeAt(0);
                  return (code >= 32 && code <= 126) || code >= 160;
                })
                .join('')
                .trim();

              const jsonMatch = cleanOutput.match(/\{.*\}/s);
              if (jsonMatch) {
                try {
                  const result = JSON.parse(jsonMatch[0]);
                  resolve(result);
                } catch (parseError) {
                  reject(
                    new Error(
                      `JSON parse error: ${parseError}. Clean output: "${cleanOutput}"`
                    )
                  );
                }
              } else {
                reject(
                  new Error(
                    `Invalid plugin output format. Clean output: "${cleanOutput}", stderr: "${stderr}"`
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
