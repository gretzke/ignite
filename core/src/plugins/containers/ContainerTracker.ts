import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';

// Simple container tracker for lifecycle management
// Tracks running containers and provides cleanup functionality
export class ContainerTracker {
  private static instance: ContainerTracker;
  private docker = new Docker();
  private runningContainers = new Set<string>(); // Container IDs

  private constructor() {}

  static getInstance(): ContainerTracker {
    if (!ContainerTracker.instance) {
      ContainerTracker.instance = new ContainerTracker();
    }
    return ContainerTracker.instance;
  }

  // Track a running container
  track(containerId: string): void {
    this.runningContainers.add(containerId);
    getLogger().debug(`📝 Tracking container: ${containerId.substring(0, 12)}`);
  }

  // Stop tracking a container
  untrack(containerId: string): void {
    this.runningContainers.delete(containerId);
    getLogger().debug(
      `📝 Stopped tracking container: ${containerId.substring(0, 12)}`
    );
  }

  // Get all tracked container IDs
  getTracked(): string[] {
    return Array.from(this.runningContainers);
  }

  // Stop all tracked containers (persistent: stop; ephemeral: they should be AutoRemove and already gone)
  async cleanup(): Promise<void> {
    if (this.runningContainers.size === 0) {
      getLogger().info('🧹 No containers to clean up');
      return;
    }

    getLogger().info(
      `🧹 Stopping ${this.runningContainers.size} tracked containers...`
    );

    for (const containerId of this.runningContainers) {
      try {
        const container = this.docker.getContainer(containerId);
        await container.stop({ t: 0 });
        getLogger().info(
          `🛑 Stopped container: ${containerId.substring(0, 12)}`
        );
        // Remove session lifecycle containers after stop
        try {
          const info = await container.inspect();
          const labels = (info?.Config?.Labels ?? {}) as Record<string, string>;
          if (labels['ignite.lifecycle'] === 'session') {
            await container.remove({ force: true });
            getLogger().info(
              `🧽 Removed session container: ${containerId.substring(0, 12)}`
            );
          }
        } catch (e) {
          getLogger().warn('Failed to remove session container:', e);
        }
      } catch (error) {
        getLogger().warn(
          `Failed to stop container ${containerId.substring(0, 12)}:`,
          error
        );
      }
    }

    this.runningContainers.clear();
    getLogger().info('✅ Container stop completed');
  }
}
