// import type { IRepoManagerPlugin } from '@ignite/plugin-types/base/repo-manager';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import type { LocalRepoOptions } from '../../types/index.js';
import { hashWorkspacePath } from '../../utils/startup.js';
import { BaseHandler } from './BaseHandler.js';
import {
  type RepoManagerOperations,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
  PathOptions,
} from '@ignite/plugin-types/base/repo-manager';
import { NoResult } from '@ignite/plugin-types/base/';

// Core-only handler interface with per-op CLI params (pathOrUrl)
type RepoHandlerCLIByOp = {
  [K in keyof RepoManagerOperations]: PathOptions;
};

type HandlerParams<K extends keyof RepoManagerOperations> =
  RepoManagerOperations[K]['params'] & RepoHandlerCLIByOp[K];

export type IRepoManagerHandler = {
  type: PluginType.REPO_MANAGER;
} & {
  [K in keyof RepoManagerOperations]: (
    options: HandlerParams<K>
  ) => Promise<PluginResponse<RepoManagerOperations[K]['result']>>;
};

export class RepoManagerHandler
  extends BaseHandler<RepoManagerOperations>
  implements IRepoManagerHandler
{
  public readonly type = PluginType.REPO_MANAGER as const;

  constructor(pluginId: string) {
    super(pluginId);
  }

  private async withRepoContainer<T>(
    pathOrUrl: string,
    allowCreateForCloned: boolean,
    fn: (containerName: string) => Promise<T>
  ): Promise<T> {
    return this.withRepoManagerContainerAuto(
      pathOrUrl,
      allowCreateForCloned,
      fn
    );
  }

  // New operation methods delegating to plugin code
  async init(options: PathOptions): Promise<PluginResponse<NoResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        true,
        async (containerName) =>
          this.executeOperation('init', options, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: init failed:`, error);
      return {
        success: false,
        error: { code: 'INIT_FAILED', message: String(error) },
      };
    }
  }

  async checkoutBranch(
    options: RepoCheckoutBranchOptions & PathOptions
  ): Promise<PluginResponse<NoResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        false,
        async (containerName) =>
          this.executeOperation('checkoutBranch', options, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: checkoutBranch failed:`, error);
      return {
        success: false,
        error: { code: 'CHECKOUT_BRANCH_FAILED', message: String(error) },
      };
    }
  }

  async checkoutCommit(
    options: RepoCheckoutCommitOptions & PathOptions
  ): Promise<PluginResponse<NoResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        false,
        async (containerName) =>
          this.executeOperation('checkoutCommit', options, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: checkoutCommit failed:`, error);
      return {
        success: false,
        error: { code: 'CHECKOUT_COMMIT_FAILED', message: String(error) },
      };
    }
  }

  async getBranches(
    options: PathOptions
  ): Promise<PluginResponse<RepoGetBranchesResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        false,
        async (containerName) =>
          this.executeOperation('getBranches', {}, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: getBranches failed:`, error);
      return {
        success: false,
        error: { code: 'GET_BRANCHES_FAILED', message: String(error) },
      };
    }
  }

  async pullChanges(options: PathOptions): Promise<PluginResponse<NoResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        false,
        async (containerName) =>
          this.executeOperation('pullChanges', {}, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: pullChanges failed:`, error);
      return {
        success: false,
        error: { code: 'PULL_FAILED', message: String(error) },
      };
    }
  }

  async getRepoInfo(
    options: PathOptions
  ): Promise<PluginResponse<RepoInfoResult>> {
    try {
      return await this.withRepoContainer(
        options.pathOrUrl,
        false,
        async (containerName) =>
          this.executeOperation('getRepoInfo', {}, containerName)
      );
    } catch (error) {
      getLogger().error(`❌ ${this.pluginId}: getRepoInfo failed:`, error);
      return {
        success: false,
        error: { code: 'GET_INFO_FAILED', message: String(error) },
      };
    }
  }

  async mount(
    options: LocalRepoOptions
  ): Promise<PluginResponse<{ containerName: string; workspacePath: string }>> {
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
          code: 'MOUNT_FAILED', // TODO: Define proper error codes
          message: String(error),
        },
      };
    }
  }

  async unmount(
    containerName: string
  ): Promise<PluginResponse<{ containerName: string; cleaned: boolean }>> {
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
          code: 'UNMOUNT_FAILED', // TODO: Define proper error codes
          message: String(error),
        },
      };
    }
  }
}
