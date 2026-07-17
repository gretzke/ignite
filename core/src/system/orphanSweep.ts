import os from 'node:os';
import Docker from 'dockerode';
import { getLogger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_GRACE_MS = 60 * 60 * 1000;
const STOP_GRACE_SECONDS =
  Number(process.env.IGNITE_CONTAINER_STOP_GRACE_SECONDS) || 2;

interface DockerResource {
  Id: string;
  Created: number | string;
  Labels?: Record<string, string>;
}

interface SweepContainer {
  stop(options: { t: number }): Promise<unknown>;
  remove(options: { force: boolean; v: boolean }): Promise<unknown>;
}

interface SweepNetwork {
  remove(): Promise<unknown>;
}

export interface OrphanSweepDocker {
  listContainers(options: {
    all: boolean;
    filters: { label: string[] };
  }): Promise<Array<DockerResource & { State: string }>>;
  getContainer(id: string): SweepContainer;
  listNetworks(options: {
    filters: { label: string[] };
  }): Promise<DockerResource[]>;
  getNetwork(id: string): SweepNetwork;
}

export interface OrphanSweepDeps {
  docker?: OrphanSweepDocker;
  isPidAlive?: (pid: number) => boolean;
  hostname?: () => string;
  now?: () => number;
}

export function ownerLabels(service?: string): Record<string, string> {
  return {
    'ignite.managed': 'true',
    'ignite.pid': String(process.pid),
    'ignite.host': os.hostname(),
    // Ignite creates containers programmatically, not via compose; the
    // compose project label is what makes Docker Desktop group them all
    // under one "ignite" stack.
    'com.docker.compose.project': 'ignite',
    ...(service ? { 'com.docker.compose.service': service } : {}),
  };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function createdAtMs(created: number | string): number {
  return typeof created === 'number' ? created * 1000 : Date.parse(created);
}

function positivePid(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function shouldRemove(
  resource: DockerResource,
  hostname: string,
  now: number,
  isPidAlive: (pid: number) => boolean
): boolean {
  const ageMs = now - createdAtMs(resource.Created);
  if (ageMs > DAY_MS) return true;

  const labels = resource.Labels ?? {};
  const pid = positivePid(labels['ignite.pid']);
  if (pid === undefined) return ageMs > LEGACY_GRACE_MS;

  const ownerHost = labels['ignite.host'];
  if (ownerHost !== undefined && ownerHost !== hostname) return false;

  return !isPidAlive(pid);
}

async function listContainers(
  docker: OrphanSweepDocker
): Promise<Array<DockerResource & { State: string }>> {
  const containers = new Map<string, DockerResource & { State: string }>();
  for (const label of ['ignite.managed=true', 'ignite-simfork=1']) {
    try {
      const listed = await docker.listContainers({
        all: true,
        filters: { label: [label] },
      });
      for (const container of listed) containers.set(container.Id, container);
    } catch (error) {
      getLogger().warn(`Orphan sweep: failed to list containers: ${error}`);
    }
  }
  return [...containers.values()];
}

async function removeContainer(
  docker: OrphanSweepDocker,
  resource: DockerResource & { State: string },
  hostname: string,
  now: number,
  isPidAlive: (pid: number) => boolean
): Promise<void> {
  try {
    if (!shouldRemove(resource, hostname, now, isPidAlive)) return;
    const container = docker.getContainer(resource.Id);
    if (!['created', 'exited', 'dead'].includes(resource.State)) {
      try {
        await container.stop({ t: STOP_GRACE_SECONDS });
      } catch (error) {
        getLogger().warn(
          `Orphan sweep: failed to stop container ${resource.Id}: ${error}`
        );
      }
    }
    try {
      await container.remove({ force: true, v: true });
      getLogger().info(`Orphan sweep: removed container ${resource.Id}`);
    } catch (error) {
      getLogger().warn(
        `Orphan sweep: failed to remove container ${resource.Id}: ${error}`
      );
    }
  } catch (error) {
    getLogger().warn(
      `Orphan sweep: failed to process container ${resource.Id}: ${error}`
    );
  }
}

async function removeNetwork(
  docker: OrphanSweepDocker,
  resource: DockerResource,
  hostname: string,
  now: number,
  isPidAlive: (pid: number) => boolean
): Promise<void> {
  try {
    if (!shouldRemove(resource, hostname, now, isPidAlive)) return;
    try {
      await docker.getNetwork(resource.Id).remove();
      getLogger().info(`Orphan sweep: removed network ${resource.Id}`);
    } catch (error) {
      getLogger().warn(
        `Orphan sweep: failed to remove network ${resource.Id}: ${error}`
      );
    }
  } catch (error) {
    getLogger().warn(
      `Orphan sweep: failed to process network ${resource.Id}: ${error}`
    );
  }
}

// Cleans only resources Ignite marked as managed. Named volumes are never
// enumerated or removed here; container removal only includes anonymous volumes.
export async function sweepOrphanedDockerResources(
  deps: OrphanSweepDeps = {}
): Promise<void> {
  try {
    const docker =
      deps.docker ?? (new Docker() as unknown as OrphanSweepDocker);
    const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    const hostname = (deps.hostname ?? os.hostname)();
    const now = (deps.now ?? Date.now)();

    const containers = await listContainers(docker);
    for (const container of containers) {
      await removeContainer(docker, container, hostname, now, isPidAlive);
    }

    try {
      const networks = await docker.listNetworks({
        filters: { label: ['ignite.managed=true'] },
      });
      for (const network of networks) {
        await removeNetwork(docker, network, hostname, now, isPidAlive);
      }
    } catch (error) {
      getLogger().warn(`Orphan sweep: failed to list networks: ${error}`);
    }
  } catch (error) {
    // Startup cleanup is opportunistic; it must never block the CLI.
    getLogger().warn(`Orphan sweep: failed unexpectedly: ${error}`);
  }
}
