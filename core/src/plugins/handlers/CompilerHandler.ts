import type {
  ICompilerPlugin,
  CompilerOperations,
  DetectOptions,
  DetectionResult,
} from '@ignite/plugin-types/base/compiler';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { BaseHandler } from './BaseHandler.js';

export class CompilerHandler
  extends BaseHandler<CompilerOperations>
  implements ICompilerPlugin
{
  public readonly type = PluginType.COMPILER as const;
  private readonly imageCache: Map<string, string> = new Map();

  constructor(pluginId: string) {
    super(pluginId);
  }

  async detect(
    options: DetectOptions
  ): Promise<PluginResponse<DetectionResult>> {
    try {
      // Centralized ensure: if hostPath provided but repo container not, create/reuse it
      const optAny = options as unknown as { hostPath?: string };
      const repoContainerName = optAny.hostPath
        ? await this.ensureRepoContainer(optAny.hostPath, {
            persistent: false,
          })
        : (() => {
            throw new Error('hostPath is required');
          })();

      const createdRepoThisCall = Boolean(optAny.hostPath);

      const result = await this.withCompilerContainer(
        repoContainerName,
        async (compilerContainerName) => {
          const result = await this.executeOperation(
            'detect',
            { workspacePath: '/workspace' },
            compilerContainerName
          );

          if (result.success && result.data) {
            getLogger().info(
              `✅ ${this.pluginId} detection: ${result.data.detected ? 'found' : 'not found'}`
            );
          }

          return result;
        }
      );

      // Stop the repo container if we created it for this request (session container)
      if (createdRepoThisCall) {
        try {
          await this.docker.getContainer(repoContainerName).stop({ t: 0 });
          getLogger().info(
            `🛑 Stopped session repo container: ${repoContainerName}`
          );
        } catch (e) {
          getLogger().debug?.(
            `⚠️ Could not stop session repo container ${repoContainerName}: ${String(e)}`
          );
        }
      }

      return result;
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId} detection failed:`, error);
      return {
        success: false,
        error: {
          code: 'DETECTION_FAILED', // TODO: Define proper error codes
          message: String(error),
        },
      };
    }
  }

  private async resolveCompilerImage(): Promise<string> {
    const cached = this.imageCache.get(this.pluginId);
    if (cached) return cached;
    const registry = PluginRegistryLoader.getInstance();
    const metadata = await registry.getPluginMetadata(this.pluginId);
    this.imageCache.set(this.pluginId, metadata.baseImage);
    return metadata.baseImage;
  }

  private async withCompilerContainer<T>(
    repoContainerName: string,
    fn: (compilerContainerName: string) => Promise<T>
  ): Promise<T> {
    const compilerImage = await this.resolveCompilerImage();

    // Derive deterministic name based on repo container's workspace hash
    let workspaceHash = 'unknown';
    try {
      const repoInfo = await this.docker
        .getContainer(repoContainerName)
        .inspect();
      const labels = repoInfo?.Config?.Labels as
        | Record<string, string>
        | undefined;
      if (labels && labels['ignite.workspaceHash']) {
        workspaceHash = labels['ignite.workspaceHash'];
      } else if (repoInfo?.Name) {
        workspaceHash = repoInfo.Name.replace('/', '');
      }
    } catch {
      // Best effort; fall back to non-hashed name component
    }

    const compilerContainerName = `ignite-compiler-${this.pluginId}-${workspaceHash}`;

    // Reuse existing compiler container; otherwise create one and persist (AutoRemove: false)
    try {
      const existing = this.docker.getContainer(compilerContainerName);
      const info = await existing.inspect();
      if (info?.State?.Running) {
        getLogger().info(
          `♻️ Reusing running compiler container: ${compilerContainerName}`
        );
      } else {
        await existing.start();
        getLogger().info(
          `▶️ Started existing compiler container: ${compilerContainerName}`
        );
      }
    } catch {
      getLogger().info(
        `🔧 ${this.pluginId}: Creating compiler container: ${compilerContainerName} (image: ${compilerImage})`
      );
      const container = await this.docker.createContainer({
        Image: compilerImage,
        name: compilerContainerName,
        HostConfig: {
          VolumesFrom: [repoContainerName],
          AutoRemove: false,
        },
        Cmd: ['sleep', 'infinity'],
        Labels: {
          'ignite.type': 'compiler',
          'ignite.compiler': this.pluginId,
          'ignite.fromRepo': repoContainerName,
          'ignite.workspaceHash': workspaceHash,
          created: new Date().toISOString(),
        },
      });
      await container.start();
    }

    try {
      return await fn(compilerContainerName);
    } finally {
      try {
        await this.docker.getContainer(compilerContainerName).stop({ t: 0 });
        getLogger().info(
          `🛑 Stopped compiler container: ${compilerContainerName}`
        );
      } catch (e) {
        getLogger().debug?.(
          `⚠️ Could not stop compiler container ${compilerContainerName}: ${String(e)}`
        );
      }
    }
  }
}
