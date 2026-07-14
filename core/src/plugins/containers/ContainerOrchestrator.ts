import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import type { PermissionGrant } from '../trust/TrustManager.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import { ownerLabels } from '../../system/orphanSweep.js';

// Container lifecycle types. Phase 3 deleted the persistent/session repo-
// container tier: every container is now EPHEMERAL, created once for a
// single operation and torn down (AutoRemove) immediately after.
export enum ContainerLifecycle {
  EPHEMERAL = 'ephemeral', // Processing containers - removed immediately after use
}

// Grace period (seconds) between SIGTERM and SIGKILL when stopping containers.
// MUST be > 0: instant SIGKILL can tear down a container's bind mount while
// compiler processes still hold files open, which triggers a "Busy inodes
// after unmount of fakeowner" kernel oops in Docker Desktop's Linux VM and
// takes down the whole Docker daemon. See docs/docker-desktop-vm-crashes.md.
const STOP_GRACE_SECONDS =
  Number(process.env.IGNITE_CONTAINER_STOP_GRACE_SECONDS) || 2;

// Container creation options
export interface ContainerCreateOptions {
  image: string;
  name: string;
  lifecycle: ContainerLifecycle;
  // Resolved trust grant — REQUIRED so no caller can create a container
  // without going through the permissioning layer.
  grant: PermissionGrant;
  labels?: Record<string, string>;
  binds?: string[];
  volumes?: Record<string, object>; // Named volumes: { '/path': {} }
  // Host workspace directory to bind at /workspace. Kept separate from
  // `binds` so the orchestrator — not the caller — owns the `:ro` decision.
  workspaceBind?: { hostPath: string };
  cmd?: string[];
  env?: string[]; // Container environment, e.g. ['KEY=value']
  user?: string; // Docker "user:group" (e.g. '1000:1000'); image default if unset
}

// Centralized container orchestrator - the ONLY way to create Docker containers
// Automatically tracks all containers and handles proper cleanup based on lifecycle
export class ContainerOrchestrator {
  private static instance: ContainerOrchestrator;
  private docker = new Docker();
  private managedContainers = new Map<string, ContainerLifecycle>(); // containerName -> lifecycle

  private constructor() {}

  static getInstance(): ContainerOrchestrator {
    if (!ContainerOrchestrator.instance) {
      ContainerOrchestrator.instance = new ContainerOrchestrator();
    }
    return ContainerOrchestrator.instance;
  }

  // Create and start a container with automatic lifecycle tracking
  async createContainer(options: ContainerCreateOptions): Promise<string> {
    const {
      image,
      name,
      lifecycle,
      grant,
      labels = {},
      binds,
      volumes,
      workspaceBind,
      cmd = ['sleep', 'infinity'],
      env,
      user,
    } = options;

    getLogger().info(`🚀 Creating ${lifecycle} container: ${name}`);

    // Add standard Ignite labels
    const allLabels = {
      ...labels,
      'ignite.lifecycle': lifecycle,
      'ignite.created': new Date().toISOString(),
      ...ownerLabels(),
    };

    // Without repoWrite, the workspace bind is mounted read-only.
    const allBinds = [...(binds ?? [])];
    if (workspaceBind) {
      const suffix = grant.repoWrite ? '' : ':ro';
      allBinds.push(`${workspaceBind.hostPath}:/workspace${suffix}`);
    }

    const createOptions: Docker.ContainerCreateOptions = {
      Image: image,
      name,
      Labels: allLabels,
      Volumes: volumes,
      Cmd: cmd,
      Env: env,
      User: user,
      HostConfig: {
        AutoRemove: lifecycle === ContainerLifecycle.EPHEMERAL, // Only ephemeral containers auto-remove
        Binds: allBinds.length > 0 ? allBinds : undefined,
        // Without net, the container gets no network stack at all.
        NetworkMode: grant.net ? 'bridge' : 'none',
      },
    };

    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer(createOptions);
      await container.start();

      // Track the container for lifecycle management
      this.managedContainers.set(name, lifecycle);

      getLogger().info(`✅ ${lifecycle} container started: ${name}`);
      return name;
    } catch (error) {
      if (container) {
        try {
          await container.remove({ force: true, v: true });
        } catch (removeError) {
          getLogger().warn(
            `⚠️ Failed to remove unstarted container ${name}:`,
            removeError
          );
        }
      }
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        // Typed so PluginExecutor can recognize a missing image and rebuild
        // installed-plugin images from their recorded install source. The
        // docker:build hint only applies to built-in images.
        const msg = `Docker image ${image} not found. Run \`npm run docker:build\` to build plugin images.`;
        getLogger().error(`❌ ${msg}`);
        throw new PluginError(msg, ErrorCodes.PLUGIN_IMAGE_MISSING, { image });
      }
      getLogger().error(`❌ Failed to create container ${name}:`, error);
      throw error;
    }
  }

  // Check if a container exists (regardless of running state)
  async containerExists(name: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(name);
      await container.inspect();
      return true;
    } catch {
      return false;
    }
  }

  // Start an existing stopped container
  async startContainer(name: string): Promise<string> {
    try {
      const container = this.docker.getContainer(name);
      await container.start();

      // Re-add to tracking
      const info = await container.inspect();
      const lifecycle = info.Config?.Labels?.[
        'ignite.lifecycle'
      ] as ContainerLifecycle;
      if (lifecycle) {
        this.managedContainers.set(name, lifecycle);
      }

      getLogger().info(`🔄 Restarted container: ${name}`);
      return name;
    } catch (error: unknown) {
      // Handle case where container is already running (HTTP 304)
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        (error as { statusCode: number }).statusCode === 304
      ) {
        getLogger().info(`✅ Container ${name} is already running`);

        // Still need to update tracking
        const container = this.docker.getContainer(name);
        const info = await container.inspect();
        const lifecycle = info.Config?.Labels?.[
          'ignite.lifecycle'
        ] as ContainerLifecycle;
        if (lifecycle) {
          this.managedContainers.set(name, lifecycle);
        }

        getLogger().info(`🔄 Using already running container: ${name}`);
        return name;
      }

      getLogger().error(`❌ Failed to start container ${name}:`, error);
      throw error;
    }
  }

  // Stop a container. Ephemeral containers (AutoRemove=true) disappear once
  // stopped; there is no other lifecycle left to preserve.
  async stopContainer(name: string): Promise<void> {
    try {
      const container = this.docker.getContainer(name);
      await container.stop({ t: STOP_GRACE_SECONDS });

      const lifecycle = this.managedContainers.get(name);
      this.managedContainers.delete(name);
      getLogger().info(
        `🛑 Stopped ${lifecycle ?? 'untracked'} container (auto-removed): ${name}`
      );
    } catch (error) {
      getLogger().warn(`⚠️ Failed to stop container ${name}:`, error);
    }
  }

  // Get all managed containers
  getManagedContainers(): Record<string, ContainerLifecycle> {
    return Object.fromEntries(this.managedContainers);
  }

  // Get a Docker container instance for direct operations (exec, inspect, etc.)
  // Container lifecycle operations should still go through orchestrator methods
  getContainer(name: string): Docker.Container {
    return this.docker.getContainer(name);
  }

  // Fast-path cleanup for CLI shutdown: hand the container stops to a
  // detached `docker` process so the CLI can exit immediately instead of
  // waiting out every container's stop grace period. Every tracked container
  // is ephemeral, so everything is both stopped and removed; the stop keeps
  // STOP_GRACE_SECONDS (an instant kill can crash Docker Desktop's VM, see
  // docs/docker-desktop-vm-crashes.md).
  cleanupDetached(): void {
    if (this.managedContainers.size === 0) {
      return;
    }

    const names = [...this.managedContainers.keys()];

    // Container names are alphanumerics and dashes only, so plain
    // space-joining is shell-safe here.
    const script = [
      `docker stop -t ${STOP_GRACE_SECONDS} ${names.join(' ')} >/dev/null 2>&1`,
      `docker rm -f -v ${names.join(' ')} >/dev/null 2>&1`,
    ].join('; ');

    try {
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      getLogger().info(
        `🧹 Detached shutdown of ${names.length} container(s) started`
      );
      this.managedContainers.clear();
    } catch (error) {
      // Leaving containers running is an acceptable fallback; they are
      // reconciled the next time the CLI starts.
      getLogger().warn(`Failed to start detached container cleanup: ${error}`);
    }
  }

  // Cleanup on CLI shutdown - every tracked container is ephemeral, so all
  // are stopped and removed; nothing persists.
  async cleanup(): Promise<void> {
    if (this.managedContainers.size === 0) {
      getLogger().info('🧹 No managed containers to clean up');
      return;
    }

    getLogger().info(
      `🧹 Container cleanup: processing ${this.managedContainers.size} managed containers...`
    );

    const cleanupPromises: Promise<void>[] = [];

    for (const containerName of this.managedContainers.keys()) {
      cleanupPromises.push(this.cleanupContainer(containerName));
    }

    await Promise.all(cleanupPromises);
    this.managedContainers.clear();

    getLogger().info('✅ Container cleanup completed');
  }

  private async cleanupContainer(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);

      // Stop the container first
      try {
        await container.stop({ t: STOP_GRACE_SECONDS });
      } catch {
        // Container might already be stopped
        getLogger().debug(`Container ${containerName} already stopped`);
      }

      try {
        await container.remove({ force: true, v: true });
        getLogger().info(`🧽 Removed container: ${containerName}`);
      } catch {
        // Ephemeral containers might already be auto-removed
        getLogger().info(
          `🧽 Container already auto-removed: ${containerName}`
        );
      }
    } catch (error) {
      getLogger().warn(`Failed to cleanup container ${containerName}:`, error);
    }
  }
}
