import Docker from 'dockerode';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import { isGitRepository, hashWorkspacePath } from '../../utils/startup.js';
import path from 'path';
import { URL } from 'node:url';

export enum RepoContainerKind {
  LOCAL = 'local',
  CLONED = 'cloned',
}

// Generic base handler for all plugin types
export abstract class BaseHandler<
  TOperations extends Record<string, { params: unknown; result: unknown }>,
> {
  protected docker = new Docker();
  protected pluginLoader = PluginAssetLoader.getInstance();
  protected pluginId: string;

  // Static property that each handler must define
  abstract readonly type: PluginType;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  // Generic method to execute any operation in container
  protected async executeOperation<K extends keyof TOperations>(
    operation: K,
    options: TOperations[K]['params'],
    containerName: string
  ): Promise<PluginResponse<TOperations[K]['result']>> {
    const container = this.docker.getContainer(containerName);

    // Load and inject plugin JavaScript
    const pluginCode = await this.pluginLoader.loadPlugin(
      this.type,
      this.pluginId
    );

    // Execute operation in container with type-safe parameters
    const optionsJson = JSON.stringify(options);
    const cmd = ['node', '-e', pluginCode, String(operation), optionsJson];

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    return new Promise((resolve, reject) => {
      exec.start({ hijack: true }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        if (!stream) {
          reject(new Error('No stream returned from container exec'));
          return;
        }

        let output = '';
        let stderr = '';

        // Handle both stdout and stderr
        stream.on('data', (chunk) => {
          const data = chunk.toString();
          if (chunk[0] === 2) {
            // stderr stream
            stderr += data.slice(8); // Remove Docker stream header
          } else {
            // stdout stream
            output += data.slice(8); // Remove Docker stream header
          }
        });

        stream.on('end', () => {
          try {
            getLogger().info(
              `🔍 Plugin stdout (${this.pluginId}): "${output}"`
            );
            getLogger().info(
              `🔍 Plugin stderr (${this.pluginId}): "${stderr}"`
            );

            // Parse JSON response from plugin
            const jsonMatch = output.match(/\{.*\}/s);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);
              resolve(result);
            } else {
              reject(
                new Error(
                  `Invalid plugin output: stdout="${output}", stderr="${stderr}"`
                )
              );
            }
          } catch (error) {
            reject(new Error(`Failed to parse plugin output: ${error}`));
          }
        });
      });
    });
  }

  // Ensure a repo container exists and is running for a given host path.
  // Returns the container name. Centralized here to avoid duplication across routes.
  protected async ensureRepoContainer(
    hostPath: string,
    options?: { persistent?: boolean; nameHint?: string }
  ): Promise<string> {
    if (!isGitRepository(hostPath)) {
      throw new Error(`Not a git repository: ${hostPath}`);
    }

    const persistent = Boolean(options?.persistent);

    // Use the local-repo handler via docker directly to avoid circular deps
    // Deterministic name matches RepoManagerHandler
    const baseImage = 'ignite/base_repo-manager:latest';
    const hash = await import('../../utils/startup.js').then((m) =>
      m.hashWorkspacePath(hostPath)
    );
    const containerName = persistent
      ? `ignite-base_repo-manager-local-repo-${hash}`
      : `ignite-base_repo-manager-session-${hash}`;

    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      if (info?.State?.Running) {
        return containerName;
      }
      await existing.start();
      return containerName;
    } catch {
      // Create if it doesn't exist
      const container = await this.docker.createContainer({
        Image: baseImage,
        name: containerName,
        HostConfig: {
          Binds: [`${hostPath}:/workspace`],
          AutoRemove: !persistent,
        },
        Cmd: ['sleep', 'infinity'],
        Labels: {
          'ignite.type': 'local-repo',
          'ignite.plugin': 'local-repo',
          'ignite.image': baseImage,
          'ignite.workspace': hostPath,
          'ignite.workspaceHash': hash,
          created: new Date().toISOString(),
        },
      });
      await container.start();
      return containerName;
    }
  }

  // === Generic repo-container lifecycle helpers (usable by multiple handlers) ===
  protected deriveRepoKind(pathOrUrl: string): RepoContainerKind {
    // Windows paths like C:\...
    if (/^[A-Za-z]:\\/.test(pathOrUrl)) return RepoContainerKind.LOCAL;
    // Unix-like absolute or ~
    if (pathOrUrl.startsWith('/') || pathOrUrl.startsWith('~')) {
      return RepoContainerKind.LOCAL;
    }
    // SSH-like git@host:owner/repo(.git)?
    if (/^git@[^:]+:.+/.test(pathOrUrl)) return RepoContainerKind.CLONED;
    try {
      const u = new URL(pathOrUrl);
      if (u.protocol === 'file:') return RepoContainerKind.LOCAL;
      if (['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) {
        return RepoContainerKind.CLONED;
      }
    } catch {
      // Not a URL
    }
    // Fallback: if contains :// assume cloned, else local
    return pathOrUrl.includes('://')
      ? RepoContainerKind.CLONED
      : RepoContainerKind.LOCAL;
  }

  protected deriveRepoContainerName(
    kind: RepoContainerKind,
    pathOrUrl: string
  ): string {
    if (kind === RepoContainerKind.LOCAL) {
      const hash = hashWorkspacePath(pathOrUrl);
      const repoName = path
        .basename(pathOrUrl)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      return `ignite-repo-local-${repoName}-${hash}`;
    }
    // cloned
    let owner = 'unknown';
    let repo = 'repo';
    try {
      const u = new URL(pathOrUrl);
      const parts = u.pathname
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
      if (parts.length >= 2) {
        owner = parts[parts.length - 2]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-');
        repo = parts[parts.length - 1]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-');
      } else if (parts.length === 1) {
        repo = parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      }
    } catch {
      const base = pathOrUrl.split('/').filter(Boolean).pop() ?? 'repo';
      repo = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    const hash = hashWorkspacePath(pathOrUrl);
    return `ignite-repo-cloned-${owner}-${repo}-${hash}`;
  }

  protected async ensureRepoManagerContainer(
    kind: RepoContainerKind,
    pathOrUrl: string
  ): Promise<string> {
    const containerName = this.deriveRepoContainerName(kind, pathOrUrl);
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      if (info?.State?.Running) return containerName;
      await existing.start();
      return containerName;
    } catch {
      const baseImage = 'ignite/base_repo-manager:latest';
      const labels: Record<string, string> = {
        'ignite.type': 'repo-manager',
        'ignite.repoKind': kind,
        'ignite.lifecycle': this.isSessionLocal(kind, pathOrUrl)
          ? 'session'
          : 'persistent',
        'ignite.plugin': this.pluginId,
        'ignite.image': baseImage,
        'ignite.workspace': '/workspace',
        'ignite.repoId': hashWorkspacePath(pathOrUrl),
        created: new Date().toISOString(),
      };
      if (kind === RepoContainerKind.LOCAL) {
        labels['ignite.sourcePath'] = pathOrUrl;
      } else {
        labels['ignite.sourceUrl'] = pathOrUrl;
      }

      const container = await this.docker.createContainer({
        Image: baseImage,
        name: containerName,
        HostConfig: {
          Binds:
            kind === RepoContainerKind.LOCAL
              ? [`${pathOrUrl}:/workspace`]
              : undefined,
          AutoRemove: false,
        },
        Cmd: ['sleep', 'infinity'],
        Labels: labels,
      });
      await container.start();
      return containerName;
    }
  }

  protected async resolveRepoManagerContainerIfExists(
    kind: RepoContainerKind,
    pathOrUrl: string
  ): Promise<string | null> {
    const containerName = this.deriveRepoContainerName(kind, pathOrUrl);
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      if (info?.State?.Running) return containerName;
      await existing.start();
      return containerName;
    } catch {
      return null;
    }
  }

  protected async withRepoManagerContainer<T>(
    kind: RepoContainerKind,
    pathOrUrl: string,
    allowCreateForCloned: boolean,
    fn: (containerName: string) => Promise<T>
  ): Promise<T> {
    const containerName =
      kind === RepoContainerKind.LOCAL
        ? await this.ensureRepoManagerContainer(
            RepoContainerKind.LOCAL,
            pathOrUrl
          )
        : allowCreateForCloned
          ? await this.ensureRepoManagerContainer(
              RepoContainerKind.CLONED,
              pathOrUrl
            )
          : await (async () => {
              const name = await this.resolveRepoManagerContainerIfExists(
                RepoContainerKind.CLONED,
                pathOrUrl
              );
              if (!name) throw new Error('REPO_NOT_INITIALIZED');
              return name;
            })();

    try {
      return await fn(containerName);
    } finally {
      try {
        await this.docker.getContainer(containerName).stop({ t: 0 });
        getLogger().info(`🛑 Stopped repo container: ${containerName}`);
      } catch (e) {
        getLogger().debug?.(
          `⚠️ Could not stop repo container ${containerName}: ${String(e)}`
        );
      }
    }
  }

  protected async withRepoManagerContainerAuto<T>(
    pathOrUrl: string,
    allowCreateForCloned: boolean,
    fn: (containerName: string) => Promise<T>
  ): Promise<T> {
    const kind = this.deriveRepoKind(pathOrUrl);
    return this.withRepoManagerContainer(
      kind,
      pathOrUrl,
      allowCreateForCloned,
      fn
    );
  }

  // Determine if a local path corresponds to the current CLI session workspace
  protected isSessionLocal(
    kind: RepoContainerKind,
    pathOrUrl: string
  ): boolean {
    if (kind !== RepoContainerKind.LOCAL) return false;
    const session = (process.env.IGNITE_WORKSPACE_PATH || '').trim();
    if (!session) return false;
    const normalizedA = path.resolve(session);
    const normalizedB = path.resolve(pathOrUrl);
    return normalizedA === normalizedB;
  }
}
