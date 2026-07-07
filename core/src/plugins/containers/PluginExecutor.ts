import os from 'node:os';
import { getLogger } from '../../utils/logger.js';
import {
  PluginRegistryLoader,
  PluginConfig,
} from '../../assets/PluginRegistryLoader.js';
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
import { PluginConfigStore } from '../config/PluginConfigStore.js';
import { VaultStore } from '../vault/VaultStore.js';
import { resolveConfig } from '../config/resolveConfig.js';

// The boolean-flag permissions gate-checked here — `secrets` is a granted-key
// list, not a boolean flag, and is resolved separately at injection time
// (Task 6/7), so it's excluded from this operation gate.
type BooleanPermission = Exclude<keyof PluginPermissions, 'secrets'>;

// SPEC.md §3.1 operations matrix: install and compile mutate the shared
// volume, verify talks to block explorers. detect/mount/etc. need no grant.
export const OPERATION_PERMISSIONS: Record<string, BooleanPermission> = {
  install: 'hostWrite',
  compile: 'hostWrite',
  verify: 'net',
};

// Returns the permission the operation needs but the grant lacks, or null.
export function missingPermission(
  operation: string,
  grant: PermissionGrant
): BooleanPermission | null {
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
// signal aborts the in-flight exec (job cancellation): the exec stream is
// destroyed and the ephemeral container is stopped, killing the plugin
// process instead of letting it keep writing to the mounted workspace.
export interface ExecuteOpts {
  onOutput?: (text: string) => void;
  workspacePath?: string;
  signal?: AbortSignal;
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
  // Config resolution deps (Task 6): non-secret values and encrypted
  // secrets, merged by resolveConfig into `options.config` before the
  // container ever sees the operation. Only touched when a plugin declares
  // configFields, so plugins without a schema pay zero extra cost.
  pluginConfigStore: Pick<PluginConfigStore, 'getValues'>;
  vaultStore: Pick<VaultStore, 'getSecret' | 'listSecretKeys'>;
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
      pluginConfigStore: deps?.pluginConfigStore ?? new PluginConfigStore(),
      vaultStore: deps?.vaultStore ?? new VaultStore(),
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
      // Installed plugins can only be granted permissions their manifest
      // requests. A denied permission that was never requested is a hard
      // failure (no approval prompt) — the plugin's own manifest says it
      // shouldn't need it, so prompting would train users to approve
      // undeclared capability escalations. Native plugins never reach here
      // (all-granted), so an empty manifest only ever bites third-party code.
      const requested =
        pluginConfig.origin === 'installed'
          ? new Set(
              (pluginConfig.metadata.permissions ?? []).map(
                (request) => request.id
              )
            )
          : null;
      if (requested && !requested.has(denied)) {
        getLogger().warn(
          `🔒 Denied ${pluginId}.${operation}: '${denied}' is not in the plugin's permission manifest`
        );
        return {
          success: false,
          error: {
            code: ErrorCodes.PERMISSION_NOT_REQUESTED,
            message: `Plugin ${pluginId} needs the '${denied}' permission to run '${operation}', but its manifest does not request it. The plugin may need an update that declares this permission.`,
            details: { pluginId, permission: denied },
          },
        };
      }
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

    // Resolve this plugin's declared config (non-secret values + granted
    // secrets) and merge it under a reserved `config` key. Plugins without a
    // configFields schema skip this entirely: options pass through unchanged
    // (no `config` key added, zero extra store reads).
    const resolvedConfig = await this.resolvePluginConfig(pluginConfig, grant);
    const optionsWithConfig = resolvedConfig
      ? { ...options, config: resolvedConfig }
      : options;

    // Execute with resolved ephemeral container; always stop it afterwards
    // (AutoRemove=true, so Docker cleans it up once stopped)
    try {
      return await this.executeOperationDirect(
        pluginConfig,
        operation,
        optionsWithConfig,
        ephemeralContainer,
        opts
      );
    } finally {
      await this.deps.containerOrchestrator.stopContainer(ephemeralContainer);
    }
  }

  // Resolves this plugin's config schema into the flat object injected into
  // the container's stdin options. Returns undefined (skip injection
  // entirely) when the plugin declares no configFields. NEVER logs the
  // resolved value — it may contain decrypted secrets.
  private async resolvePluginConfig(
    pluginConfig: PluginConfig,
    grant: PermissionGrant
  ): Promise<Record<string, unknown> | undefined> {
    const configFields = pluginConfig.metadata.configFields;
    if (!configFields || configFields.length === 0) return undefined;

    const pluginId = pluginConfig.metadata.id;
    const [configValues, secretKeys] = await Promise.all([
      this.deps.pluginConfigStore.getValues(pluginId),
      this.deps.vaultStore.listSecretKeys(pluginId),
    ]);

    // listSecretKeys returns raw vault entry keys scoped to this plugin:
    // "<pluginId>::<key>" (global) or "<pluginId>::<key>::<chainId>"
    // (per-chain). Derive the chainIds with a stored value for a given
    // field key by filtering on the per-chain prefix.
    const getSecretChainIds = async (key: string): Promise<number[]> => {
      const keyPrefix = `${pluginId}::${key}::`;
      return secretKeys
        .filter((entry) => entry.startsWith(keyPrefix))
        .map((entry) => Number(entry.slice(keyPrefix.length)))
        .filter((chainId) => Number.isFinite(chainId));
    };

    return resolveConfig({
      metadata: pluginConfig.metadata,
      grant,
      configValues,
      getSecret: (key, chainId) =>
        this.deps.vaultStore.getSecret(pluginId, key, chainId),
      getSecretChainIds,
    });
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
        opts?.onOutput,
        opts?.signal
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
