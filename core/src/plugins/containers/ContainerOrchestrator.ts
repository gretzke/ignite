import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import type { PermissionGrant } from '../trust/TrustManager.js';

// Container lifecycle types
export enum ContainerLifecycle {
  PERSISTENT = 'persistent', // Saved repos - preserved across CLI sessions
  SESSION = 'session', // Current workspace - removed on CLI shutdown
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
  volumesFrom?: string[];
  cmd?: string[];
  env?: string[]; // Container environment, e.g. ['KEY=value']
}

// Centralized container orchestrator - the ONLY way to create Docker containers
// Automatically tracks all containers and handles proper cleanup based on lifecycle
export class ContainerOrchestrator {
  private static instance: ContainerOrchestrator;
  private docker = new Docker();
  private managedContainers = new Map<string, ContainerLifecycle>(); // containerName -> lifecycle
  private containerRefCounts = new Map<string, number>(); // containerName -> reference count

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
      volumesFrom,
      cmd = ['sleep', 'infinity'],
      env,
    } = options;

    getLogger().info(`🚀 Creating ${lifecycle} container: ${name}`);

    // Add standard Ignite labels
    const allLabels = {
      ...labels,
      'ignite.lifecycle': lifecycle,
      'ignite.managed': 'true',
      'ignite.created': new Date().toISOString(),
    };

    const createOptions: Docker.ContainerCreateOptions = {
      Image: image,
      name,
      Labels: allLabels,
      Volumes: volumes,
      Cmd: cmd,
      Env: env,
      HostConfig: {
        AutoRemove: lifecycle === ContainerLifecycle.EPHEMERAL, // Only ephemeral containers auto-remove
        Binds: binds,
        // Without hostWrite, shared repo volumes are mounted read-only.
        VolumesFrom: volumesFrom?.map((source) =>
          grant.hostWrite ? source : `${source}:ro`
        ),
        // Without net, the container gets no network stack at all.
        NetworkMode: grant.net ? 'bridge' : 'none',
      },
    };

    try {
      const container = await this.docker.createContainer(createOptions);
      await container.start();

      // Track the container for lifecycle management
      this.managedContainers.set(name, lifecycle);

      // Initialize reference count
      this.containerRefCounts.set(name, 1);

      getLogger().info(`✅ ${lifecycle} container started: ${name} (refs: 1)`);
      return name;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        const msg = `Docker image ${image} not found. Run \`npm run docker:build\` to build plugin images.`;
        getLogger().error(`❌ ${msg}`);
        throw new Error(msg);
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

      // Increment reference count
      const currentCount = this.containerRefCounts.get(name) || 0;
      this.containerRefCounts.set(name, currentCount + 1);

      getLogger().info(
        `🔄 Restarted container: ${name} (refs: ${currentCount + 1})`
      );
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

        // Still need to update tracking and reference count
        const container = this.docker.getContainer(name);
        const info = await container.inspect();
        const lifecycle = info.Config?.Labels?.[
          'ignite.lifecycle'
        ] as ContainerLifecycle;
        if (lifecycle) {
          this.managedContainers.set(name, lifecycle);
        }

        // Increment reference count
        const currentCount = this.containerRefCounts.get(name) || 0;
        this.containerRefCounts.set(name, currentCount + 1);

        getLogger().info(
          `🔄 Using already running container: ${name} (refs: ${currentCount + 1})`
        );
        return name;
      }

      getLogger().error(`❌ Failed to start container ${name}:`, error);
      throw error;
    }
  }

  // Stop a container (but don't remove unless it's ephemeral with AutoRemove)
  async stopContainer(name: string): Promise<void> {
    try {
      // Decrement reference count
      const currentCount = this.containerRefCounts.get(name) || 0;
      const newCount = Math.max(0, currentCount - 1);
      this.containerRefCounts.set(name, newCount);

      getLogger().info(
        `📉 Container ${name} ref count: ${currentCount} -> ${newCount}`
      );

      // Only actually stop the container if reference count reaches zero
      if (newCount === 0) {
        const container = this.docker.getContainer(name);
        await container.stop({ t: STOP_GRACE_SECONDS });

        const lifecycle = this.managedContainers.get(name);
        if (lifecycle === ContainerLifecycle.EPHEMERAL) {
          // Ephemeral containers auto-remove, so untrack them
          this.managedContainers.delete(name);
          this.containerRefCounts.delete(name);
          getLogger().info(
            `🛑 Stopped ephemeral container (auto-removed): ${name}`
          );
        } else {
          getLogger().info(`🛑 Stopped ${lifecycle} container: ${name}`);
        }
      } else {
        getLogger().info(
          `⏸️ Container ${name} still in use (refs: ${newCount}), not stopping`
        );
      }
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
  // waiting out every container's stop grace period. Same semantics as
  // cleanup(): everything is stopped, only session/ephemeral containers are
  // removed, and the stop keeps STOP_GRACE_SECONDS (an instant kill can
  // crash Docker Desktop's VM, see docs/docker-desktop-vm-crashes.md).
  cleanupDetached(): void {
    if (this.managedContainers.size === 0) {
      return;
    }

    const stopNames: string[] = [];
    const removeNames: string[] = [];
    for (const [containerName, lifecycle] of this.managedContainers.entries()) {
      stopNames.push(containerName);
      if (
        lifecycle === ContainerLifecycle.SESSION ||
        lifecycle === ContainerLifecycle.EPHEMERAL
      ) {
        removeNames.push(containerName);
      }
    }

    // Container names are derived by RepoContainerUtils (alphanumerics and
    // dashes only), so plain space-joining is shell-safe here.
    const script = [
      `docker stop -t ${STOP_GRACE_SECONDS} ${stopNames.join(' ')} >/dev/null 2>&1`,
      removeNames.length > 0
        ? `docker rm -f ${removeNames.join(' ')} >/dev/null 2>&1`
        : ':',
    ].join('; ');

    try {
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      getLogger().info(
        `🧹 Detached shutdown of ${stopNames.length} container(s) started`
      );
      this.managedContainers.clear();
      this.containerRefCounts.clear();
    } catch (error) {
      // Leaving containers running is an acceptable fallback; they are
      // reconciled the next time the CLI starts.
      getLogger().warn(`Failed to start detached container cleanup: ${error}`);
    }
  }

  // Cleanup on CLI shutdown - remove ephemeral and session containers, preserve persistent
  async cleanup(): Promise<void> {
    if (this.managedContainers.size === 0) {
      getLogger().info('🧹 No managed containers to clean up');
      return;
    }

    getLogger().info(
      `🧹 Container cleanup: processing ${this.managedContainers.size} managed containers...`
    );

    const cleanupPromises: Promise<void>[] = [];

    for (const [containerName, lifecycle] of this.managedContainers.entries()) {
      cleanupPromises.push(this.cleanupContainer(containerName, lifecycle));
    }

    await Promise.all(cleanupPromises);
    this.managedContainers.clear();
    this.containerRefCounts.clear();

    getLogger().info('✅ Container cleanup completed');
  }

  private async cleanupContainer(
    containerName: string,
    lifecycle: ContainerLifecycle
  ): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);

      // Stop the container first
      try {
        await container.stop({ t: STOP_GRACE_SECONDS });
      } catch {
        // Container might already be stopped
        getLogger().debug(`Container ${containerName} already stopped`);
      }

      // Handle removal based on lifecycle
      if (
        lifecycle === ContainerLifecycle.SESSION ||
        lifecycle === ContainerLifecycle.EPHEMERAL
      ) {
        try {
          await container.remove({ force: true });
          getLogger().info(
            `🧽 Removed ${lifecycle} container: ${containerName}`
          );
        } catch (removeError) {
          // Ephemeral containers might already be auto-removed
          if (lifecycle === ContainerLifecycle.EPHEMERAL) {
            getLogger().info(
              `🧽 Ephemeral container already auto-removed: ${containerName}`
            );
          } else {
            getLogger().warn(
              `Failed to remove ${lifecycle} container ${containerName}:`,
              removeError
            );
          }
        }
      } else {
        getLogger().info(
          `💾 Preserved ${lifecycle} container: ${containerName}`
        );
      }
    } catch (error) {
      getLogger().warn(`Failed to cleanup container ${containerName}:`, error);
    }
  }
}
