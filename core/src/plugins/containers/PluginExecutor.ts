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

// Unified plugin executor - delegates to dynamic handlers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private containerOrchestrator = ContainerOrchestrator.getInstance();
  private registryLoader = PluginRegistryLoader.getInstance();
  // Serializes repo-container resolution per repo to avoid check-then-create races
  private repoContainerMutex = new KeyedMutex();

  private constructor() {}

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
    options: Record<string, unknown>
  ): Promise<PluginResponse<unknown>> {
    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    // Get plugin config for type and lifecycle info
    const pluginConfig = await this.registryLoader.getPluginConfig(pluginId);
    const lifecycle = pluginConfig.lifecycle;

    getLogger().info(`🔄 Plugin ${pluginId} lifecycle: ${lifecycle}`);

    // Resolve the trust grant once; everything downstream enforces it.
    const grant = await TrustManager.getInstance().getGrant(pluginId);

    const denied = missingPermission(operation, grant);
    if (denied) {
      getLogger().warn(
        `🔒 Denied ${pluginId}.${operation}: missing '${denied}' permission (trust: ${grant.trust})`
      );
      return {
        success: false,
        error: {
          code: 'PERMISSION_REQUIRED',
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
          grant
        );
      case PluginLifecycle.EPHEMERAL:
        return await this.executeEphemeralPlugin(
          pluginConfig,
          operation,
          options,
          grant
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
    grant: PermissionGrant
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(
      `📁 Executing persistent plugin: ${pluginId}.${operation}`
    );

    // Extract pathOrUrl and resolve container for repo plugins
    const { pathOrUrl } = this.extractPathInfo(options);

    // Inject credentials for repo-manager plugins
    if (pluginConfig.metadata.type === PluginType.REPO_MANAGER) {
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
        containerName
      );
    } finally {
      await this.containerOrchestrator.stopContainer(containerName);
    }
  }

  // Execute ephemeral plugin - short-lived containers, auto-cleanup
  private async executeEphemeralPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    grant: PermissionGrant
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
        ephemeralContainer
      );
    } finally {
      await this.containerOrchestrator.stopContainer(ephemeralContainer);
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

    const labels: Record<string, string> = {
      'ignite.type': 'ephemeral',
      'ignite.plugin': pluginId,
      'ignite.image': pluginConfig.metadata.baseImage,
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

      // Determine repo container name deterministically
      const repoKind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
      const isSession = RepoContainerUtils.isSessionLocal(repoKind, pathOrUrl);

      // Try persistent container first, then session container
      const persistentName = await RepoContainerUtils.deriveRepoContainerName(
        repoKind,
        pathOrUrl,
        false
      );
      const sessionName = await RepoContainerUtils.deriveRepoContainerName(
        repoKind,
        pathOrUrl,
        true
      );

      // Check which container exists and start it if needed (prefer persistent over session)
      let repoContainer: string | null = null;

      // Try persistent container first
      if (await this.containerOrchestrator.containerExists(persistentName)) {
        repoContainer = persistentName;
      } else if (
        isSession &&
        (await this.containerOrchestrator.containerExists(sessionName))
      ) {
        repoContainer = sessionName;
      }

      if (!repoContainer) {
        throw new Error(`No repository container found for ${pathOrUrl}`);
      }

      volumesFrom = [repoContainer];
      labels['ignite.repoContainer'] = repoContainer;

      getLogger().info(
        `🔗 Ephemeral container will use volumes from: ${repoContainer}`
      );
    }

    return await this.containerOrchestrator.createContainer({
      image: pluginConfig.metadata.baseImage,
      name: ephemeralContainerName,
      lifecycle: ContainerLifecycle.EPHEMERAL,
      labels,
      volumesFrom,
      grant,
    });
  }

  // Execute operation directly without handler - new handler-free approach
  private async executeOperationDirect(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    containerName: string
  ): Promise<PluginResponse<unknown>> {
    try {
      // Call PluginExecutionUtils directly - no handler needed
      return await PluginExecutionUtils.executeOperation(
        pluginConfig.metadata.type,
        pluginConfig.metadata.id,
        operation,
        options,
        containerName
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'OPERATION_EXECUTION_FAILED',
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

    // Strategy: Prefer persistent over session containers
    let containerName: string;
    let preferredLifecycle: ContainerLifecycle;

    if (isSession) {
      // For session paths, check if persistent version exists first
      const persistentName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        false
      );
      const sessionName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        true
      );

      // Try persistent first (user might have saved this workspace)
      if (await this.containerOrchestrator.containerExists(persistentName)) {
        await this.containerOrchestrator.startContainer(persistentName);
        getLogger().info(
          `🔄 Using existing persistent container for session path: ${persistentName}`
        );
        return persistentName;
      }

      // No persistent container exists, use session
      containerName = sessionName;
      preferredLifecycle = ContainerLifecycle.SESSION;
      getLogger().info(
        `📁 Using session container for temporary workspace: ${sessionName}`
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

    // Check if preferred container exists and start it
    if (await this.containerOrchestrator.containerExists(containerName)) {
      return await this.containerOrchestrator.startContainer(containerName);
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
        return await this.containerOrchestrator.startContainer(containerName);
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

    return await this.containerOrchestrator.createContainer({
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

    const credentialManager = await GitCredentialManager.getInstance();

    // Get SSH credentials for this repository (if available)
    const sshCredentials =
      await credentialManager.getSSHCredentialsForContainer(pathOrUrl);

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
    await this.containerOrchestrator.cleanup();

    getLogger().info('✅ Plugin Executor cleanup completed');
  }
}
