import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';

// Container lifecycle types
export enum ContainerLifecycle {
  PERSISTENT = 'persistent', // Saved repos - preserved across CLI sessions
  SESSION = 'session', // Current workspace - removed on CLI shutdown
  EPHEMERAL = 'ephemeral', // Processing containers - removed immediately after use
}

// Container creation options
export interface ContainerCreateOptions {
  image: string;
  name: string;
  lifecycle: ContainerLifecycle;
  labels?: Record<string, string>;
  binds?: string[];
  volumesFrom?: string[];
  cmd?: string[];
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
      labels = {},
      binds,
      volumesFrom,
      cmd = ['sleep', 'infinity'],
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
      Cmd: cmd,
      HostConfig: {
        AutoRemove: lifecycle === ContainerLifecycle.EPHEMERAL, // Only ephemeral containers auto-remove
        Binds: binds,
        VolumesFrom: volumesFrom,
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
      getLogger().error(`❌ Failed to create container ${name}:`, error);
      throw error;
    }
  }

  // Get an existing container if it's running, otherwise return null
  async getRunningContainer(name: string): Promise<string | null> {
    try {
      const container = this.docker.getContainer(name);
      const info = await container.inspect();

      if (info?.State?.Running) {
        // Add to tracking if not already tracked
        if (!this.managedContainers.has(name)) {
          const lifecycle = info.Config?.Labels?.[
            'ignite.lifecycle'
          ] as ContainerLifecycle;
          if (lifecycle) {
            this.managedContainers.set(name, lifecycle);
            getLogger().info(
              `📝 Discovered existing ${lifecycle} container: ${name}`
            );
          }
        }

        // Increment reference count for existing running container
        const currentCount = this.containerRefCounts.get(name) || 0;
        this.containerRefCounts.set(name, currentCount + 1);
        getLogger().info(
          `📝 Using existing container: ${name} (refs: ${currentCount + 1})`
        );

        return name;
      }

      return null;
    } catch {
      return null;
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
    } catch (error) {
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
        await container.stop({ t: 0 });

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
        await container.stop({ t: 0 });
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
