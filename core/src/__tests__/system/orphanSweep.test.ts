import { describe, expect, it, vi } from 'vitest';
import {
  sweepOrphanedDockerResources,
  type OrphanSweepDocker,
} from '../../system/orphanSweep.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type ContainerResource = {
  Id: string;
  Created: number;
  Labels?: Record<string, string>;
  State: string;
};

type NetworkResource = {
  Id: string;
  Created: string;
  Labels?: Record<string, string>;
};

function container(
  id: string,
  ageMs: number,
  labels: Record<string, string> = {},
  state = 'exited'
): ContainerResource {
  return {
    Id: id,
    Created: (NOW - ageMs) / 1000,
    Labels: labels,
    State: state,
  };
}

function network(
  id: string,
  ageMs: number,
  labels: Record<string, string> = {}
): NetworkResource {
  return {
    Id: id,
    Created: new Date(NOW - ageMs).toISOString(),
    Labels: labels,
  };
}

function sweepDeps(
  options: {
    managed?: ContainerResource[];
    simfork?: ContainerResource[];
    networks?: NetworkResource[];
    alive?: (pid: number) => boolean;
    handlers?: Record<
      string,
      { stop?: ReturnType<typeof vi.fn>; remove?: ReturnType<typeof vi.fn> }
    >;
    networkRemoves?: Record<string, ReturnType<typeof vi.fn>>;
  } = {}
) {
  const handlers = options.handlers ?? {};
  const networkRemoves = options.networkRemoves ?? {};
  const docker: OrphanSweepDocker = {
    listContainers: vi.fn(async (request) =>
      request.filters.label[0] === 'ignite.managed=true'
        ? (options.managed ?? [])
        : (options.simfork ?? [])
    ),
    getContainer: vi.fn((id) => ({
      stop: handlers[id]?.stop ?? vi.fn(async () => undefined),
      remove: handlers[id]?.remove ?? vi.fn(async () => undefined),
    })),
    listNetworks: vi.fn(async () => options.networks ?? []),
    getNetwork: vi.fn((id) => ({
      remove: networkRemoves[id] ?? vi.fn(async () => undefined),
    })),
  };
  return {
    docker,
    isPidAlive: options.alive ?? (() => false),
    hostname: () => 'local-host',
    now: () => NOW,
  };
}

describe('sweepOrphanedDockerResources', () => {
  it('gracefully stops and removes dead-PID running containers with anonymous volumes', async () => {
    const calls: string[] = [];
    const stop = vi.fn(async () => calls.push('stop'));
    const remove = vi.fn(async () => calls.push('remove'));
    const deps = sweepDeps({
      managed: [
        container(
          'dead-running',
          HOUR,
          {
            'ignite.pid': '42',
            'ignite.host': 'local-host',
          },
          'running'
        ),
      ],
      handlers: { 'dead-running': { stop, remove } },
    });

    await sweepOrphanedDockerResources(deps);

    expect(stop).toHaveBeenCalledWith({ t: 2 });
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(calls).toEqual(['stop', 'remove']);
  });

  it('removes created-state dead-PID containers without stopping them', async () => {
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container(
            'created',
            HOUR,
            {
              'ignite.pid': '42',
              'ignite.host': 'local-host',
            },
            'created'
          ),
        ],
        handlers: { created: { stop, remove } },
      })
    );

    expect(stop).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it('gracefully stops paused dead-PID containers before removing them', async () => {
    const calls: string[] = [];
    const stop = vi.fn(async () => calls.push('stop'));
    const remove = vi.fn(async () => calls.push('remove'));
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container(
            'paused',
            HOUR,
            {
              'ignite.pid': '42',
              'ignite.host': 'local-host',
            },
            'paused'
          ),
        ],
        handlers: { paused: { stop, remove } },
      })
    );

    expect(stop).toHaveBeenCalledWith({ t: 2 });
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(calls).toEqual(['stop', 'remove']);
  });

  it('skips a same-host resource while its owner PID is alive', async () => {
    const remove = vi.fn(async () => undefined);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container('live', HOUR, {
            'ignite.pid': '42',
            'ignite.host': 'local-host',
          }),
        ],
        alive: () => true,
        handlers: { live: { remove } },
      })
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes same-host live-PID resources older than 24 hours', async () => {
    const remove = vi.fn(async () => undefined);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container('old-live', DAY + 1, {
            'ignite.pid': '42',
            'ignite.host': 'local-host',
          }),
        ],
        alive: () => true,
        handlers: { 'old-live': { remove } },
      })
    );
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it('skips foreign-host resources until they exceed 24 hours without checking PID liveness', async () => {
    const recentRemove = vi.fn(async () => undefined);
    const oldRemove = vi.fn(async () => undefined);
    const alive = vi.fn(() => false);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container('foreign-recent', HOUR, {
            'ignite.pid': '42',
            'ignite.host': 'other-host',
          }),
          container('foreign-old', DAY + 1, {
            'ignite.pid': '42',
            'ignite.host': 'other-host',
          }),
        ],
        alive,
        handlers: {
          'foreign-recent': { remove: recentRemove },
          'foreign-old': { remove: oldRemove },
        },
      })
    );
    expect(recentRemove).not.toHaveBeenCalled();
    expect(oldRemove).toHaveBeenCalledWith({ force: true, v: true });
    expect(alive).not.toHaveBeenCalled();
  });

  it('skips a dead-PID resource whose host label is present but empty', async () => {
    const remove = vi.fn(async () => undefined);
    const alive = vi.fn(() => false);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container('empty-host', HOUR, {
            'ignite.pid': '42',
            'ignite.host': '',
          }),
        ],
        alive,
        handlers: { 'empty-host': { remove } },
      })
    );

    expect(remove).not.toHaveBeenCalled();
    expect(alive).not.toHaveBeenCalled();
  });

  it('age-gates legacy resources without a PID label', async () => {
    const recentRemove = vi.fn(async () => undefined);
    const oldRemove = vi.fn(async () => undefined);
    await sweepOrphanedDockerResources(
      sweepDeps({
        managed: [
          container('legacy-recent', HOUR - 1),
          container('legacy-old', HOUR + 1),
        ],
        handlers: {
          'legacy-recent': { remove: recentRemove },
          'legacy-old': { remove: oldRemove },
        },
      })
    );
    expect(recentRemove).not.toHaveBeenCalled();
    expect(oldRemove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it('sweeps legacy simulation containers discovered by their old label', async () => {
    const remove = vi.fn(async () => undefined);
    const deps = sweepDeps({
      simfork: [
        container('legacy-simfork', HOUR + 1, { 'ignite-simfork': '1' }),
      ],
      handlers: { 'legacy-simfork': { remove } },
    });
    await sweepOrphanedDockerResources(deps);

    expect(deps.docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['ignite-simfork=1'] },
    });
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it('removes dead-PID networks and skips live-PID networks', async () => {
    const deadRemove = vi.fn(async () => undefined);
    const liveRemove = vi.fn(async () => undefined);
    const deps = sweepDeps({
      networks: [
        network('dead-network', HOUR, {
          'ignite.pid': '1',
          'ignite.host': 'local-host',
        }),
        network('live-network', HOUR, {
          'ignite.pid': '2',
          'ignite.host': 'local-host',
        }),
      ],
      alive: (pid) => pid === 2,
      networkRemoves: {
        'dead-network': deadRemove,
        'live-network': liveRemove,
      },
    });
    await sweepOrphanedDockerResources(deps);

    expect(deadRemove).toHaveBeenCalled();
    expect(liveRemove).not.toHaveBeenCalled();
  });

  it('isolates resource failures and continues to networks when container listing fails', async () => {
    const failedRemove = vi.fn(async () => {
      throw new Error('remove failed');
    });
    const nextRemove = vi.fn(async () => undefined);
    const networkRemove = vi.fn(async () => undefined);
    const deps = sweepDeps({
      managed: [
        container('remove-fails', HOUR, {
          'ignite.pid': '1',
          'ignite.host': 'local-host',
        }),
        container('remove-succeeds', HOUR, {
          'ignite.pid': '2',
          'ignite.host': 'local-host',
        }),
      ],
      networks: [
        network('network-after-failure', HOUR, {
          'ignite.pid': '3',
          'ignite.host': 'local-host',
        }),
      ],
      handlers: {
        'remove-fails': { remove: failedRemove },
        'remove-succeeds': { remove: nextRemove },
      },
      networkRemoves: { 'network-after-failure': networkRemove },
    });

    await expect(sweepOrphanedDockerResources(deps)).resolves.toBeUndefined();
    expect(nextRemove).toHaveBeenCalled();
    expect(networkRemove).toHaveBeenCalled();

    const listFailureDocker: OrphanSweepDocker = {
      ...deps.docker,
      listContainers: vi.fn(async () => {
        throw new Error('Docker unavailable');
      }),
    };
    await expect(
      sweepOrphanedDockerResources({
        ...deps,
        docker: listFailureDocker,
      })
    ).resolves.toBeUndefined();
    expect(networkRemove).toHaveBeenCalledTimes(2);
  });
});
