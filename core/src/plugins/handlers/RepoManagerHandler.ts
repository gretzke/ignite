import type { IRepoManagerPlugin } from '@ignite/plugin-types/base/repo-manager';
import type { PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import type { RepoManagerOperations } from '@ignite/plugin-types/base/repo-manager';
import { getLogger } from '../../utils/logger.js';
import type { LocalRepoOptions } from '../../types/index.js';
import { hashWorkspacePath } from '../../utils/startup.js';
import { BaseHandler } from './BaseHandler.js';

export class RepoManagerHandler
  extends BaseHandler<RepoManagerOperations>
  implements IRepoManagerPlugin
{
  public readonly type = PluginType.REPO_MANAGER as const;

  constructor(pluginId: string) {
    super(pluginId);
  }

  async mount(
    options: LocalRepoOptions
  ): Promise<PluginResult<{ containerName: string; workspacePath: string }>> {
    try {
      // Determine container naming strategy
      const baseImage = 'ignite/base_repo-manager:latest';
      const isPersistent = Boolean(options.persistent);
      const hash = hashWorkspacePath(options.hostPath);
      const containerName = isPersistent
        ? `ignite-base_repo-manager-${this.pluginId}-${hash}`
        : `ignite-base_repo-manager-session-${hash}`;

      // If a container with this deterministic name already exists, ensure it is running and reuse it
      try {
        const existing = this.docker.getContainer(containerName);
        const info = await existing.inspect();
        if (info?.State?.Running) {
          getLogger().info(
            `♻️  ${this.pluginId}: Reusing running repo container: ${containerName}`
          );
        } else {
          getLogger().info(
            `▶️  ${this.pluginId}: Starting existing repo container: ${containerName}`
          );
          await existing.start();
        }

        return {
          success: true,
          data: {
            containerName,
            workspacePath: '/workspace',
          },
        };
      } catch {
        // Not found → create below
      }

      getLogger().info(
        `📁 ${this.pluginId}: Creating local repo container: ${containerName} -> ${options.hostPath}`
      );

      const container = await this.docker.createContainer({
        Image: baseImage,
        name: containerName,
        HostConfig: {
          Binds: [`${options.hostPath}:/workspace`],
          // Ephemeral (cwd): removed on stop; Persistent: kept across sessions
          AutoRemove: !isPersistent,
        },
        Cmd: ['sleep', 'infinity'], // Keep container running
        Labels: {
          'ignite.type': 'local-repo',
          'ignite.plugin': this.pluginId,
          'ignite.image': baseImage,
          'ignite.workspace': options.hostPath,
          'ignite.workspaceHash': hash,
          'ignite.hostPath': options.hostPath,
          created: new Date().toISOString(),
        },
      });

      await container.start();

      getLogger().info(
        `✅ ${this.pluginId}: Local repo container created: ${containerName}`
      );

      return {
        success: true,
        data: {
          containerName,
          workspacePath: '/workspace',
        },
      };
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: Failed to mount repo:`, error);
      return {
        success: false,
        error: {
          message: String(error),
        },
      };
    }
  }

  async unmount(
    containerName: string
  ): Promise<PluginResult<{ containerName: string; cleaned: boolean }>> {
    try {
      getLogger().info(
        `🗑️ ${this.pluginId}: Unmounting repo container: ${containerName}`
      );

      const container = this.docker.getContainer(containerName);

      // Stop and remove container
      await container.stop();
      await container.remove();

      getLogger().info(
        `✅ ${this.pluginId}: Repo container unmounted: ${containerName}`
      );

      return {
        success: true,
        data: {
          containerName,
          cleaned: true,
        },
      };
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: Failed to unmount repo:`, error);
      return {
        success: false,
        error: {
          message: String(error),
        },
      };
    }
  }

  async cleanup(): Promise<PluginResult<{ cleaned: number }>> {
    try {
      getLogger().info(
        `🧹 ${this.pluginId}: Cleaning up orphaned repo containers...`
      );

      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['ignite.type=local-repo'],
        },
      });

      let cleaned = 0;
      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          await container.remove({ force: true });
          cleaned++;
          getLogger().info(
            `🗑️ ${this.pluginId}: Cleaned container: ${containerInfo.Names[0]}`
          );
        } catch (error) {
          getLogger().warn(
            `⚠️ ${this.pluginId}: Failed to clean container ${containerInfo.Id}:`,
            error
          );
        }
      }

      getLogger().info(
        `✅ ${this.pluginId}: Cleanup complete: ${cleaned} containers removed`
      );

      return {
        success: true,
        data: { cleaned },
      };
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: Cleanup failed:`, error);
      return {
        success: false,
        error: {
          message: String(error),
        },
      };
    }
  }
}
