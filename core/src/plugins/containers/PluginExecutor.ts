import { getLogger } from '../../utils/logger.js';
import {
  PluginRegistryLoader,
  PluginLifecycle,
  PluginConfig,
} from '../../assets/PluginRegistryLoader.js';
import {
  ContainerOrchestrator,
  ContainerLifecycle,
} from './ContainerOrchestrator.js';
import {
  RepoContainerKind,
  RepoContainerUtils,
} from '../utils/RepoContainerUtils.js';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginExecutionUtils } from '../utils/PluginExecutionUtils.js';
import { hashWorkspacePath } from '../../utils/startup.js';
import { GitCredentialManager } from '../utils/GitCredentialManager.js';
import { KeyedMutex } from '../../utils/KeyedMutex.js';
import { setTimeout } from 'node:timers/promises';
import {
  TrustManager,
  type PermissionGrant,
  type PluginPermissions,
} from '../trust/TrustManager.js';
import {
  PLUGIN_CACHE_ENV,
  PLUGIN_CACHE_MOUNT,
  pluginCacheVolumeName,
} from '../utils/pluginCache.js';
import { ErrorCodes } from '../../types/errors.js';

// SPEC.md §3.1 operations matrix: install and compile mutate the shared
// volume, verify talks to block explorers. detect/mount/etc. need no grant.
export const OPERATION_PERMISSIONS: Record<string, keyof PluginPermissions> = {
  install: 'hostWrite',
  compile: 'hostWrite',
  verify: 'net',
};

// Returns the permission the operation needs but the grant lacks, or null.
export function missingPermission(
  operation: string,
  grant: PermissionGrant
): keyof PluginPermissions | null {
  const required = OPERATION_PERMISSIONS[operation];
  if (required && !grant[required]) return required;
  return null;
}

// Persistent Plugin Lifecycle (repo plugins):
// - Long-lived containers (AutoRemove=false)
// - Exception: Session containers (current IGNITE_WORKSPACE_PATH) are removed on shutdown
// - Regular containers are stopped (not removed) on shutdown for data persistence
//
// Ephemeral Plugin Lifecycle (processing plugins):
// - Short-lived containers (AutoRemove=true)
// - Created with VolumesFrom=[repoContainer] when requiresRepo=true
// - Automatically removed after operation completion

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface PluginExecutorDeps {
  containerOrchestrator: Pick<
    ContainerOrchestrator,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'containerExists'
    | 'getContainer'
    | 'cleanup'
    | 'cleanupDetached'
  >;
  registryLoader: Pick<PluginRegistryLoader, 'getPluginConfig'>;
  trust: Pick<TrustManager, 'getGrant'>;
  getSSHCredentialsForContainer: (
    pathOrUrl: string
  ) => Promise<{ privateKey: string; publicKey: string } | null>;
  executeOperation: (typeof PluginExecutionUtils)['executeOperation'];
}

// Unified plugin executor - delegates to dynamic handlers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private deps: PluginExecutorDeps;
  // Serializes repo-container resolution per repo to avoid check-then-create races
  private repoContainerMutex = new KeyedMutex();

  constructor(deps?: Partial<PluginExecutorDeps>) {
    this.deps = {
      containerOrchestrator:
        deps?.containerOrchestrator ?? ContainerOrchestrator.getInstance(),
      registryLoader:
        deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
      trust: deps?.trust ?? TrustManager.getInstance(),
      getSSHCredentialsForContainer:
        deps?.getSSHCredentialsForContainer ??
        (async (pathOrUrl: string) =>
          (
            await GitCredentialManager.getInstance()
          ).getSSHCredentialsForContainer(pathOrUrl)),
      executeOperation:
        deps?.executeOperation ??
        PluginExecutionUtils.executeOperation.bind(PluginExecutionUtils),
    };
  }

  // Get singleton instance of PluginExecutor
  static getInstance(): PluginExecutor {
    if (!PluginExecutor.instance) {
      PluginExecutor.instance = new PluginExecutor();
    }
    return PluginExecutor.instance;
  }

  // Execute a single plugin operation with lifecycle-based container management
  async execute(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts?: { onOutput?: (text: string) => void }
  ): Promise<PluginResponse<unknown>> {
    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    // Get plugin config for type and lifecycle info
    const pluginConfig =
      await this.deps.registryLoader.getPluginConfig(pluginId);
    const lifecycle = pluginConfig.lifecycle;

    getLogger().info(`🔄 Plugin ${pluginId} lifecycle: ${lifecycle}`);

    // Resolve the trust grant once; everything downstream enforces it.
    const grant = await this.deps.trust.getGrant(pluginId);

    const denied = missingPermission(operation, grant);
    if (denied) {
      getLogger().warn(
        `🔒 Denied ${pluginId}.${operation}: missing '${denied}' permission (trust: ${grant.trust})`
      );
      return {
        success: false,
        error: {
          code: ErrorCodes.PERMISSION_REQUIRED,
          message: `Plugin ${pluginId} requires the '${denied}' permission to run '${operation}'. Approve it in the plugin settings.`,
          details: { pluginId, permission: denied },
        },
      };
    }

    // Execute based on plugin lifecycle from metadata
    switch (lifecycle) {
      case PluginLifecycle.PERSISTENT:
        return await this.executePersistentPlugin(
          pluginConfig,
          operation,
          options,
          grant,
          opts
        );
      case PluginLifecycle.EPHEMERAL:
        return await this.executeEphemeralPlugin(
          pluginConfig,
          operation,
          options,
          grant,
          opts
        );
      default: {
        const _exhaustiveCheck: never = lifecycle;
        throw new Error(`Unsupported plugin lifecycle: ${lifecycle}`);
      }
    }
  }

  // Execute persistent plugin - long-lived containers, tracked lifecycle
  private async executePersistentPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    grant: PermissionGrant,
    opts?: { onOutput?: (text: string) => void }
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(
      `📁 Executing persistent plugin: ${pluginId}.${operation}`
    );

    // Extract pathOrUrl and resolve container for repo plugins
    const { pathOrUrl } = this.extractPathInfo(options);

    // Inject credentials for repo-manager plugins. Restricted to built-in
    // origin: PluginInstaller.install() already rejects installing a
    // REPO_MANAGER-typed plugin, but this is defense-in-depth against any
    // future bypass of that check (a third-party plugin self-declares its
    // type via getInfo, so it must never be trusted to gate credentials).
    if (
      pluginConfig.origin === 'builtin' &&
      pluginConfig.metadata.type === PluginType.REPO_MANAGER
    ) {
      options = await this.injectGitCredentials(options, pathOrUrl);
    }

    const containerName = await this.resolveRepoContainer(
      pluginId,
      pathOrUrl,
      grant
    );

    // Always release the container reference, even if execution throws
    try {
      return await this.executeOperationDirect(
        pluginConfig,
        operation,
        options,
        containerName,
        opts
      );
    } finally {
      await this.deps.containerOrchestrator.stopContainer(containerName);
    }
  }

  // Execute ephemeral plugin - short-lived containers, auto-cleanup
  private async executeEphemeralPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    grant: PermissionGrant,
    opts?: { onOutput?: (text: string) => void }
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(`⚡ Executing ephemeral plugin: ${pluginId}.${operation}`);

    // Create ephemeral container with repo dependency resolution
    const ephemeralContainer = await this.createEphemeralContainer(
      pluginConfig,
      options,
      grant
    );

    // Execute with resolved ephemeral container; always stop it afterwards
    // (AutoRemove=true, so Docker cleans it up once stopped)
    const { ...cleanOptions } = this.extractPathInfo(options);
    try {
      return await this.executeOperationDirect(
        pluginConfig,
        operation,
        cleanOptions,
        ephemeralContainer,
        opts
      );
    } finally {
      await this.deps.containerOrchestrator.stopContainer(ephemeralContainer);
    }
  }

  // Create ephemeral container with AutoRemove=true and VolumesFrom repo if needed
  private async createEphemeralContainer(
    pluginConfig: PluginConfig,
    options: Record<string, unknown>,
    grant: PermissionGrant
  ): Promise<string> {
    const pluginId = pluginConfig.metadata.id;

    // Generate unique container name to prevent race conditions with concurrent requests
    // Uses: timestamp + process ID + random component for guaranteed uniqueness
    const timestamp = Date.now();
    const processId = process.pid;
    const randomId = Math.random().toString(36).substring(2, 8); // 6 character random string
    const ephemeralContainerName = `ignite-ephemeral-${pluginId}-${timestamp}-${processId}-${randomId}`;

    getLogger().info(
      `🔄 Creating ephemeral container: ${ephemeralContainerName}`
    );

    // Private persistent cache, shared across this plugin's runs. Docker
    // creates the named volume on first use; uninstall removes it.
    const cacheVolume = pluginCacheVolumeName(pluginId);

    const labels: Record<string, string> = {
      'ignite.type': 'ephemeral',
      'ignite.plugin': pluginId,
      'ignite.image': pluginConfig.metadata.baseImage,
      'ignite.cacheVolume': cacheVolume,
    };

    let volumesFrom: string[] | undefined;

    // Add VolumesFrom if repo dependency is required
    if (pluginConfig.requiresRepo) {
      const { pathOrUrl } = this.extractPathInfo(options);

      if (!pathOrUrl) {
        throw new Error(
          `Repository path required for ephemeral plugin: ${pluginConfig.metadata.id}`
        );
      }

      const repoContainer = await RepoContainerUtils.findExistingRepoContainer(
        pathOrUrl,
        (name) => this.deps.containerOrchestrator.containerExists(name)
      );
      if (!repoContainer) {
        throw new Error(`No repository container found for ${pathOrUrl}`);
      }

      volumesFrom = [repoContainer];
      labels['ignite.repoContainer'] = repoContainer;

      getLogger().info(
        `🔗 Ephemeral container will use volumes from: ${repoContainer}`
      );
    }

    const containerName = await this.deps.containerOrchestrator.createContainer(
      {
        image: pluginConfig.metadata.baseImage,
        name: ephemeralContainerName,
        lifecycle: ContainerLifecycle.EPHEMERAL,
        labels,
        binds: [`${cacheVolume}:${PLUGIN_CACHE_MOUNT}`],
        volumes: { [PLUGIN_CACHE_MOUNT]: {} },
        env: [`${PLUGIN_CACHE_ENV}=${PLUGIN_CACHE_MOUNT}`],
        volumesFrom,
        grant,
      }
    );

    await this.ensureCacheWritable(containerName);

    return containerName;
  }

  // Docker creates named volumes root-owned, but plugin images may run as an
  // unprivileged user (e.g. ignite/shared runs as 'plugin'). Open up the
  // mount /tmp-style (sticky, world-writable) via a root exec so any
  // container user can use its private cache. Best-effort: an image without
  // chmod just ends up with an unusable cache, not a failed operation.
  private async ensureCacheWritable(containerName: string): Promise<void> {
    try {
      const container =
        this.deps.containerOrchestrator.getContainer(containerName);
      const exec = await container.exec({
        Cmd: ['chmod', '1777', PLUGIN_CACHE_MOUNT],
        User: '0:0',
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
        stream.on('error', () => resolve());
        stream.resume();
      });
    } catch (error) {
      getLogger().warn(
        `⚠️ Could not make ${PLUGIN_CACHE_MOUNT} writable in ${containerName}: ${error}`
      );
    }
  }

  // Execute operation directly without handler - new handler-free approach
  private async executeOperationDirect(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    containerName: string,
    opts?: { onOutput?: (text: string) => void }
  ): Promise<PluginResponse<unknown>> {
    try {
      // Call PluginExecutionUtils directly - no handler needed
      return await this.deps.executeOperation(
        pluginConfig.metadata.type,
        pluginConfig.metadata.id,
        operation,
        options,
        containerName,
        pluginConfig.origin,
        opts?.onOutput
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: ErrorCodes.OPERATION_EXECUTION_FAILED,
          message: `Operation execution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  // Extract pathOrUrl from options for container resolution
  private extractPathInfo(options: Record<string, unknown>): {
    pathOrUrl?: string;
    [key: string]: unknown;
  } {
    const { pathOrUrl, ...cleanOptions } = options;
    return { pathOrUrl: pathOrUrl as string | undefined, ...cleanOptions };
  }

  // Resolve repository container for persistent plugins.
  // Serialized per repo path: concurrent requests would otherwise both pass the
  // containerExists() check and race to create the same container.
  private async resolveRepoContainer(
    pluginId: string,
    pathOrUrl: string | undefined,
    grant: PermissionGrant
  ): Promise<string> {
    if (!pathOrUrl) {
      throw new Error(
        `Repository path required for persistent plugin: ${pluginId}`
      );
    }

    return this.repoContainerMutex.run(pathOrUrl, () =>
      this.resolveRepoContainerLocked(pluginId, pathOrUrl, grant)
    );
  }

  private async resolveRepoContainerLocked(
    pluginId: string,
    pathOrUrl: string,
    grant: PermissionGrant
  ): Promise<string> {
    const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
    const isSession = RepoContainerUtils.isSessionLocal(kind, pathOrUrl);

    // Reuse fast path: prefer an existing persistent container over session.
    const existing = await RepoContainerUtils.findExistingRepoContainer(
      pathOrUrl,
      (name) => this.deps.containerOrchestrator.containerExists(name)
    );
    if (existing) {
      return await this.deps.containerOrchestrator.startContainer(existing);
    }

    // Strategy: Prefer persistent over session containers
    let containerName: string;
    let preferredLifecycle: ContainerLifecycle;

    if (isSession) {
      // No persistent container exists, use session
      containerName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        true
      );
      preferredLifecycle = ContainerLifecycle.SESSION;
      getLogger().info(
        `📁 Using session container for temporary workspace: ${containerName}`
      );
    } else {
      // Non-session path - always use persistent
      containerName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        false
      );
      preferredLifecycle = ContainerLifecycle.PERSISTENT;
    }

    // Container doesn't exist, create new one
    try {
      return await this.createRepoContainer(
        kind,
        pathOrUrl,
        containerName,
        preferredLifecycle,
        pluginId,
        grant
      );
    } catch (error: unknown) {
      // Handle race condition - another request might have created the container
      if (
        (typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          error.statusCode === 409) ||
        (error instanceof Error && error.message?.includes('already in use'))
      ) {
        getLogger().info(
          `🔄 Container ${containerName} created by concurrent request, attempting to use it`
        );
        // Wait a bit and try to start the container created by concurrent request
        await setTimeout(100);
        return await this.deps.containerOrchestrator.startContainer(
          containerName
        );
      }
      throw error;
    }
  }

  // Create a new repository container with the specified lifecycle
  private async createRepoContainer(
    kind: RepoContainerKind,
    pathOrUrl: string,
    containerName: string,
    lifecycle: ContainerLifecycle,
    pluginId: string,
    grant: PermissionGrant
  ): Promise<string> {
    const baseImage = 'ignite/base_repo-manager:latest';
    const labels: Record<string, string> = {
      'ignite.type': 'repo-manager',
      'ignite.repoKind': kind,
      'ignite.plugin': pluginId,
      'ignite.image': baseImage,
      'ignite.workspace': '/workspace',
      'ignite.repoId': hashWorkspacePath(pathOrUrl),
    };

    if (kind === RepoContainerKind.LOCAL) {
      labels['ignite.sourcePath'] = pathOrUrl;
    } else {
      labels['ignite.sourceUrl'] = pathOrUrl;
    }

    // Configure volume mounting based on repository type
    let binds: string[] | undefined;
    let volumes: Record<string, object> | undefined;

    if (kind === RepoContainerKind.LOCAL) {
      // Local repos: use bind mounts for direct host access
      binds = [`${pathOrUrl}:/workspace`];
    } else {
      // Cloned repos: use named volumes for isolation and sharing
      const volumeName = `ignite-cloned-${hashWorkspacePath(pathOrUrl)}`;
      binds = [`${volumeName}:/workspace`];
      volumes = { '/workspace': {} };

      getLogger().info(`🗄️ Using named volume for cloned repo: ${volumeName}`);
    }

    return await this.deps.containerOrchestrator.createContainer({
      image: baseImage,
      name: containerName,
      lifecycle,
      labels,
      binds,
      volumes,
      grant,
    });
  }

  // Inject Git credentials into repo-manager operation options
  private async injectGitCredentials(
    options: Record<string, unknown>,
    pathOrUrl?: string
  ): Promise<Record<string, unknown>> {
    if (!pathOrUrl) {
      getLogger().debug('No pathOrUrl provided, skipping credential injection');
      return options;
    }

    // Get SSH credentials for this repository (if available)
    const sshCredentials =
      await this.deps.getSSHCredentialsForContainer(pathOrUrl);

    if (!sshCredentials) {
      getLogger().debug(
        'Repo public or no SSH credentials available for repository:',
        pathOrUrl
      );
      return options;
    }

    getLogger().debug('Injecting SSH credentials for repository:', pathOrUrl);

    // Create credentials object matching the plugin interface
    const gitCredentials = {
      type: 'ssh' as const,
      privateKey: sshCredentials.privateKey,
      publicKey: sshCredentials.publicKey,
    };

    // Inject credentials into options
    return {
      ...options,
      gitCredentials,
    };
  }

  // Cleanup
  async cleanup(): Promise<void> {
    getLogger().info('🧹 Cleaning up Plugin Executor...');

    // ContainerOrchestrator handles all container lifecycle management
    await this.deps.containerOrchestrator.cleanup();

    getLogger().info('✅ Plugin Executor cleanup completed');
  }

  // Fast-path cleanup for CLI shutdown: container stops run in a detached
  // process so the CLI is not held open by them
  cleanupDetached(): void {
    this.deps.containerOrchestrator.cleanupDetached();
  }
}
