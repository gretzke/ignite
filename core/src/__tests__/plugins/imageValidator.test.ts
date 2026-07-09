import { describe, it, expect, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { JobRecord } from '@ignite/api';
import { validatePluginImages } from '../../plugins/utils/ImageValidator.js';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import type { JobRunner, JobContext } from '../../jobs/JobManager.js';

const builtinConfig: PluginConfig = {
  metadata: {
    id: 'foundry',
    types: [PluginType.COMPILER],
    name: 'Foundry',
    version: '1.0.0',
    baseImage: 'ignite/foundry:latest',
    imageHash: 'hash-abc',
  } as PluginConfig['metadata'],
  requiresRepo: true,
  origin: 'builtin',
};

const installedConfig: PluginConfig = {
  metadata: {
    id: 'waffle',
    types: [PluginType.COMPILER],
    name: 'Waffle',
    version: '0.5.1',
    baseImage: 'ignite/installed_waffle:0.5.1',
  } as PluginConfig['metadata'],
  requiresRepo: true,
  origin: 'installed',
};

function makeJobs() {
  const started: {
    type: string;
    params: Record<string, unknown>;
    runner: JobRunner;
  }[] = [];
  return {
    started,
    jobs: {
      start: vi.fn(
        (
          type: string,
          params: Record<string, unknown>,
          runner: JobRunner
        ): JobRecord => {
          started.push({ type, params, runner });
          return {
            id: `job-${started.length}`,
            type,
            params,
            state: 'queued',
            createdAt: new Date().toISOString(),
            events: [],
          };
        }
      ),
    },
  };
}

const ctx: JobContext = {
  log: () => {},
  signal: new globalThis.AbortController().signal,
};

describe('validatePluginImages (startup image check)', () => {
  it('enqueues a plugin.rebuild job for a missing INSTALLED image whose runner calls rebuildImage', async () => {
    const { jobs, started } = makeJobs();
    const rebuildImage = vi.fn(async () => {});

    await validatePluginImages({
      getAllPlugins: async () => ({
        foundry: builtinConfig,
        waffle: installedConfig,
      }),
      inspectImage: async (tag: string) => {
        if (tag === installedConfig.metadata.baseImage) {
          throw new Error('no such image');
        }
        return { labels: { 'ignite.dockerfileHash': 'hash-abc' } };
      },
      jobs,
      rebuildImage,
    });

    expect(started).toHaveLength(1);
    expect(started[0].type).toBe('plugin.rebuild');
    expect(started[0].params).toEqual({
      pluginId: 'waffle',
      image: 'ignite/installed_waffle:0.5.1',
    });
    // The rebuild itself happens inside the job runner, not synchronously.
    expect(rebuildImage).not.toHaveBeenCalled();
    await started[0].runner(ctx);
    expect(rebuildImage).toHaveBeenCalledWith('waffle');
  });

  it('keeps the docker:build error path for missing BUILT-IN images (no job)', async () => {
    const { jobs, started } = makeJobs();
    const rebuildImage = vi.fn(async () => {});

    await validatePluginImages({
      getAllPlugins: async () => ({ foundry: builtinConfig }),
      inspectImage: async () => {
        throw new Error('no such image');
      },
      jobs,
      rebuildImage,
    });

    expect(started).toHaveLength(0);
    expect(rebuildImage).not.toHaveBeenCalled();
  });

  it('enqueues nothing when all images exist', async () => {
    const { jobs, started } = makeJobs();

    await validatePluginImages({
      getAllPlugins: async () => ({
        foundry: builtinConfig,
        waffle: installedConfig,
      }),
      inspectImage: async () => ({
        labels: { 'ignite.dockerfileHash': 'hash-abc' },
      }),
      jobs,
      rebuildImage: vi.fn(async () => {}),
    });

    expect(started).toHaveLength(0);
  });

  it('fails the rebuild job (rethrow) when rebuildImage rejects', async () => {
    const { jobs, started } = makeJobs();

    await validatePluginImages({
      getAllPlugins: async () => ({ waffle: installedConfig }),
      inspectImage: async () => {
        throw new Error('no such image');
      },
      jobs,
      rebuildImage: vi.fn(async () => {
        throw new Error(
          "Cannot rebuild plugin 'waffle': its git install recorded no pinned commit"
        );
      }),
    });

    expect(started).toHaveLength(1);
    await expect(started[0].runner(ctx)).rejects.toThrow(/no pinned commit/);
  });
});
