import type { IRepoManagerPlugin } from '@ignite/plugin-types/base/repo-manager';
import type { PluginResult } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import type { LocalRepoOptions } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import Docker from 'dockerode';

export class RepoManagerHandler implements IRepoManagerPlugin {
  public readonly type = PluginType.REPO_MANAGER as const;
  private docker = new Docker();
  private readonly volumePrefix = 'ignite-repo';
  private readonly pluginId: string;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  async mount(
    options: LocalRepoOptions
  ): Promise<PluginResult<{ containerName: string; workspacePath: string }>> {
    try {
      const containerName = this.generateVolumeName('local', options.name);

      getLogger().info(
        `📁 ${this.pluginId}: Creating local repo container: ${containerName} -> ${options.hostPath}`
      );

      const container = await this.docker.createContainer({
        Image: 'ignite/shared-repo-manager:latest',
        name: containerName,
        HostConfig: {
          Binds: [`${options.hostPath}:/workspace`],
          AutoRemove: false, // Keep container alive for volume sharing
        },
        Cmd: ['sleep', 'infinity'], // Keep container running
        Labels: {
          'ignite.type': 'local-repo',
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
        error: String(error),
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
        error: String(error),
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
        error: String(error),
      };
    }
  }

  private generateVolumeName(type: string, id: string): string {
    return `${this.volumePrefix}-${type}-${id}`;
  }
}
