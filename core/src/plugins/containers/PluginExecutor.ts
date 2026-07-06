import os from 'node:os';
import { getLogger } from '../../utils/logger.js';
import { PluginRegistryLoader, PluginConfig } from '../../assets/PluginRegistryLoader.js';
import {
  ContainerOrchestrator,
  ContainerLifecycle,
} from './ContainerOrchestrator.js';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginExecutionUtils } from '../utils/PluginExecutionUtils.js';
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

// Every plugin is EPHEMERAL (Phase 3 deleted the persistent/repo-container
// tier): short-lived containers (AutoRemove=true), bind-mounting the host
// workspace directly at /workspace when requiresRepo=true (grant enforcement
// downgrades the bind to :ro), automatically removed after the operation
// completes.

// Threaded through execute() -> executeEphemeralPlugin. Plugins that
// requiresRepo use workspacePath to bind-mount the host workspace directly.
export interface ExecuteOpts {
  onOutput?: (text: string) => void;
  workspacePath?: string;
}

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface PluginExecutorDeps {
  containerOrchestrator: Pick<
    ContainerOrchestrator,
    | 'createContainer'
    | 'stopContainer'
    | 'getContainer'
    | 'cleanup'
    | 'cleanupDetached'
  >;
  registryLoader: Pick<PluginRegistryLoader, 'getPluginConfig'>;
  trust: Pick<TrustManager, 'getGrant'>;
  executeOperation: (typeof PluginExecutionUtils)['executeOperation'];
}

// Unified plugin executor - delegates to dynamic handlers
export class PluginExecutor {
  private static instance: PluginExecutor;
  private deps: PluginExecutorDeps;

  constructor(deps?: Partial<PluginExecutorDeps>) {
    this.deps = {
      containerOrchestrator:
        deps?.containerOrchestrator ?? ContainerOrchestrator.getInstance(),
      registryLoader:
        deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
      trust: deps?.trust ?? TrustManager.getInstance(),
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

  // Execute a single plugin operation. Every plugin runs in an ephemeral
  // container (Phase 3 deleted the persistent/repo-container lifecycle).
  async execute(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts?: ExecuteOpts
  ): Promise<PluginResponse<unknown>> {
    getLogger().info(`🔌 Executing ${pluginId}.${operation}`);

    const pluginConfig =
      await this.deps.registryLoader.getPluginConfig(pluginId);

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

    return await this.executeEphemeralPlugin(
      pluginConfig,
      operation,
      options,
      grant,
      opts
    );
  }

  // Execute ephemeral plugin - short-lived containers, auto-cleanup
  private async executeEphemeralPlugin(
    pluginConfig: PluginConfig,
    operation: string,
    options: Record<string, unknown>,
    grant: PermissionGrant,
    opts?: ExecuteOpts
  ): Promise<PluginResponse<unknown>> {
    const pluginId = pluginConfig.metadata.id;
    getLogger().info(`⚡ Executing ephemeral plugin: ${pluginId}.${operation}`);

    // Create ephemeral container, binding the host workspace directly when
    // the plugin requiresRepo (Phase 3: no more repo-container VolumesFrom).
    const ephemeralContainer = await this.createEphemeralContainer(
      pluginConfig,
      grant,
      opts?.workspacePath
    );

    // Execute with resolved ephemeral container; always stop it afterwards
    // (AutoRemove=true, so Docker cleans it up once stopped)
    try {
      return await this.executeOperationDirect(
        pluginConfig,
        operation,
        options,
        ephemeralContainer,
        opts
      );
    } finally {
      await this.deps.containerOrchestrator.stopContainer(ephemeralContainer);
    }
  }

  // Create ephemeral container with AutoRemove=true, bind-mounting the host
  // workspace directly when the plugin requiresRepo (grant enforcement — the
  // orchestrator downgrades to :ro without hostWrite — mirrors the old
  // VolumesFrom rule this replaces).
  private async createEphemeralContainer(
    pluginConfig: PluginConfig,
    grant: PermissionGrant,
    workspacePath?: string
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

    let workspaceBind: { hostPath: string } | undefined;

    // requiresRepo now means "needs the host workspace bind-mounted".
    if (pluginConfig.requiresRepo) {
      if (!workspacePath) {
        throw new Error(
          `Workspace path required for ephemeral plugin: ${pluginId}`
        );
      }
      workspaceBind = { hostPath: workspacePath };
      labels['ignite.workspace'] = workspacePath;
      getLogger().info(
        `🔗 Ephemeral container will bind-mount workspace: ${workspacePath}`
      );
    }

    const env = [`${PLUGIN_CACHE_ENV}=${PLUGIN_CACHE_MOUNT}`];
    let user: string | undefined;
    // Docker Desktop (macOS/Windows) runs the daemon in a VM and remaps
    // container-root-owned files to the host user transparently, so image
    // default is fine there. Native Linux Docker has no such remap: a
    // root-run compiler would leave root-owned artifacts in the bind-mounted
    // workspace. Untested on Linux — flag if this surfaces ownership issues.
    if (process.platform === 'linux') {
      const { uid, gid } = os.userInfo();
      user = `${uid}:${gid}`;
      env.push('HOME=/tmp');
    }

    const containerName = await this.deps.containerOrchestrator.createContainer(
      {
        image: pluginConfig.metadata.baseImage,
        name: ephemeralContainerName,
        lifecycle: ContainerLifecycle.EPHEMERAL,
        labels,
        binds: [`${cacheVolume}:${PLUGIN_CACHE_MOUNT}`],
        volumes: { [PLUGIN_CACHE_MOUNT]: {} },
        env,
        workspaceBind,
        user,
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
    opts?: ExecuteOpts
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
