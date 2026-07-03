import type { Duplex } from 'stream';
import { setTimeout, clearTimeout } from 'node:timers';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import { ContainerOrchestrator } from '../containers/ContainerOrchestrator.js';
import { getLogger } from '../../utils/logger.js';
import type { PluginOrigin } from '../../assets/PluginRegistryLoader.js';

// Utility class for executing plugin operations in containers
export class PluginExecutionUtils {
  private static pluginLoader = PluginAssetLoader.getInstance();
  private static containerOrchestrator = ContainerOrchestrator.getInstance();

  // Built-in plugins have their bundle injected as a string (node -e); installed
  // plugins carry the bundle inside their self-contained image at /plugin/index.js.
  // The operation is appended as argv, options are still sent over stdin.
  static buildExecCommand(
    origin: PluginOrigin,
    pluginCode: string | null
  ): string[] {
    if (origin === 'installed') {
      return ['node', '/plugin/index.js'];
    }
    if (pluginCode === null) {
      throw new Error('Built-in plugin execution requires injected bundle code');
    }
    return ['node', '-e', pluginCode];
  }

  // Execute a plugin operation in a container
  static async executeOperation<TResult>(
    pluginType: PluginType,
    pluginId: string,
    operation: string,
    options: unknown,
    containerName: string,
    origin: PluginOrigin
  ): Promise<PluginResponse<TResult>> {
    const container = this.containerOrchestrator.getContainer(containerName);

    // Built-in bundles are injected from the host; installed plugins run the
    // bundle baked into their image.
    const pluginCode =
      origin === 'builtin'
        ? await this.pluginLoader.loadPlugin(pluginType, pluginId)
        : null;

    // Options are passed via stdin (not argv) so secrets like git credentials
    // never show up in the container's process list or `docker inspect` output
    const optionsJson = JSON.stringify(options);
    const cmd = [
      ...this.buildExecCommand(origin, pluginCode),
      String(operation),
    ];

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const timeoutMs =
      Number(process.env.IGNITE_PLUGIN_EXEC_TIMEOUT_MS) || 15 * 60 * 1000;

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(fn: (value: T) => void, value: T) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };

      exec.start(
        { hijack: true, stdin: true },
        (err: Error | null, stream: Duplex | undefined) => {
          if (err) {
            settle(reject, err);
            return;
          }

          if (!stream) {
            settle(
              reject,
              new Error('No stream returned from container exec')
            );
            return;
          }

          timer = setTimeout(() => {
            stream.destroy();
            reject(
              new Error(
                `Plugin ${pluginId}.${operation} timed out after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);

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
              // Debug-level + truncated: plugin output can be large and may
              // echo repository contents
              getLogger().debug(
                `🔍 Plugin stdout (${pluginId}): "${output.slice(0, 2000)}"`
              );
              getLogger().debug(
                `🔍 Plugin stderr (${pluginId}): "${stderr.slice(0, 2000)}"`
              );

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
                  settle(resolve, result);
                } catch (parseError) {
                  settle(
                    reject,
                    new Error(
                      `JSON parse error: ${parseError}. Clean output: "${cleanOutput}"`
                    )
                  );
                }
              } else {
                settle(
                  reject,
                  new Error(
                    `Invalid plugin output format. Clean output: "${cleanOutput}", stderr: "${stderr}"`
                  )
                );
              }
            } catch (error) {
              settle(
                reject,
                new Error(`Failed to parse plugin output: ${error}`)
              );
            }
          });

          // Send options on stdin and half-close so the plugin sees EOF;
          // output continues to flow on the same hijacked connection
          stream.write(optionsJson);
          stream.end();
        }
      );
    });
  }
}
