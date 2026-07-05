import type { Duplex } from 'stream';
import { setTimeout, clearTimeout } from 'node:timers';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import { ContainerOrchestrator } from '../containers/ContainerOrchestrator.js';
import { getLogger } from '../../utils/logger.js';
import type { PluginOrigin } from '../../assets/PluginRegistryLoader.js';
import {
  createDockerStreamDemuxer,
  parsePluginOutput,
} from './pluginTransport.js';
import { INSTALLED_PLUGIN_ENTRYPOINT } from '../install/types.js';

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
      return ['node', INSTALLED_PLUGIN_ENTRYPOINT];
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
    origin: PluginOrigin,
    onOutput?: (text: string) => void
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

          // Both streams feed the same onOutput sink — job logs don't
          // distinguish stdout/stderr, and the sentinel-framed result line
          // is intentionally not filtered out here (by design; see task brief).
          const demux = createDockerStreamDemuxer(
            onOutput ? (_stream, text) => onOutput(text) : undefined
          );

          stream.on('data', (chunk: Buffer) => demux.push(chunk));

          stream.on('end', () => {
            const { stdout, stderr } = demux.result();
            try {
              getLogger().debug(
                `🔍 Plugin stdout (${pluginId}): "${stdout.slice(0, 2000)}"`
              );
              getLogger().debug(
                `🔍 Plugin stderr (${pluginId}): "${stderr.slice(0, 2000)}"`
              );
              settle(
                resolve,
                parsePluginOutput(stdout, stderr) as PluginResponse<TResult>
              );
            } catch (error) {
              settle(
                reject,
                error instanceof Error ? error : new Error(String(error))
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
