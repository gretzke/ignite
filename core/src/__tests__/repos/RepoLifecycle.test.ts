import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { JobRecord, RepoRecord } from '@ignite/api';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import {
  RepoLifecycle,
  type RepoLifecycleDeps,
} from '../../repos/RepoLifecycle.js';
import type { JobRunner } from '../../jobs/JobManager.js';
import { createTestDirectory, cleanupTestDirectory } from '../setup.js';

interface StartedJob {
  record: JobRecord;
  runner: JobRunner;
}

// Deferred-execution fake mirroring JobManager's contract: start() returns a
// queued record immediately; runAll() executes runners (including ones
// started by other runners) until none remain.
function makeFakeJobs() {
  const started: StartedJob[] = [];
  const states = new Map<string, JobRecord['state']>();
  let nextId = 0;
  const jobs = {
    started,
    states,
    start: vi.fn(
      (type: string, params: Record<string, unknown>, runner: JobRunner) => {
        const record: JobRecord = {
          id: `job-${nextId++}`,
          type,
          params,
          state: 'queued',
          createdAt: new Date().toISOString(),
          events: [],
        };
        states.set(record.id, 'running');
        started.push({ record, runner });
        return record;
      }
    ),
    get: vi.fn((id: string): JobRecord | undefined => {
      const item = started.find((s) => s.record.id === id);
      if (!item) return undefined;
      return { ...item.record, state: states.get(id) ?? 'queued' };
    }),
    async runAll(): Promise<void> {
      let next = started.find((s) => states.get(s.record.id) === 'running');
      while (next) {
        const ctx = {
          log: () => {},
          signal: new AbortController().signal,
        };
        try {
          await next.runner(ctx);
          states.set(next.record.id, 'succeeded');
        } catch {
          states.set(next.record.id, 'failed');
        }
        next = started.find((s) => states.get(s.record.id) === 'running');
      }
    },
  };
  return jobs;
}

interface ExecCall {
  pluginId: string;
  op: string;
}

function makeFakeExecutor(
  responses: Record<string, Record<string, PluginResponse<unknown>>>
) {
  const calls: ExecCall[] = [];
  return {
    calls,
    execute: vi.fn(
      async (
        pluginId: string,
        op: string
      ): Promise<PluginResponse<unknown>> => {
        calls.push({ pluginId, op });
        const canned = responses[pluginId]?.[op];
        if (!canned) {
          return { success: true, data: {} };
        }
        return canned;
      }
    ),
  };
}

function makeCompilerConfigs(ids: string[]) {
  return ids.map((id) => ({
    metadata: {
      id,
      types: [PluginType.COMPILER],
      name: id[0].toUpperCase() + id.slice(1),
      version: '1.0.0',
      baseImage: `ignite/compiler_${id}:latest`,
    },
    repoRead: true,
    origin: 'builtin' as const,
  }));
}

function makeLifecycle(opts: {
  workspaceDir: string;
  repos?: RepoRecord[];
  compilers?: string[];
  responses?: Record<string, Record<string, PluginResponse<unknown>>>;
  sessionPath?: string | null;
  pinnedPath?: string;
}) {
  const jobs = makeFakeJobs();
  const executor = makeFakeExecutor(opts.responses ?? {});
  const updates: Array<{
    profileId: string;
    pathOrUrl: string;
    patch: Partial<Pick<RepoRecord, 'frameworks' | 'detectedAt' | 'originUrl'>>;
  }> = [];
  const registry = {
    updates,
    list: vi.fn(async () => ({
      session: opts.sessionPath ?? null,
      local: opts.repos ?? [],
      cloned: [] as RepoRecord[],
    })),
    updateRepoState: vi.fn(
      async (
        profileId: string,
        pathOrUrl: string,
        patch: Partial<Pick<RepoRecord, 'frameworks' | 'detectedAt' | 'originUrl'>>
      ) => {
        updates.push({ profileId, pathOrUrl, patch });
      }
    ),
  };
  const repoService = {
    init: vi.fn(async () => ({ success: true as const, data: null })),
    getVersionSource: vi.fn(async () => ({
      url: `file://${opts.workspaceDir}`,
      workspacePath: opts.workspaceDir,
      localFallbackPath: opts.workspaceDir,
    })),
    resolveWorkspacePath: vi.fn(async () => opts.workspaceDir),
    withVersionMaterialized: vi.fn(
      async (_profileId, _url, _commit, _opts, fn) =>
        fn({
          checkout: opts.pinnedPath ?? opts.workspaceDir,
          rematerialize: async () => ({
            checkout: opts.pinnedPath ?? opts.workspaceDir,
          }),
        })
    ),
  };
  const registryLoader = {
    getPluginsByType: vi.fn(async () =>
      makeCompilerConfigs(opts.compilers ?? ['foundry'])
    ),
  };
  const versionStore = {
    checkoutPath: vi.fn(() => opts.pinnedPath ?? opts.workspaceDir),
    get: vi.fn(async () => undefined),
    updateState: vi.fn(async () => {}),
  };
  const deps: RepoLifecycleDeps = {
    jobs: jobs as unknown as RepoLifecycleDeps['jobs'],
    executor: executor as unknown as RepoLifecycleDeps['executor'],
    registryLoader:
      registryLoader as unknown as RepoLifecycleDeps['registryLoader'],
    repos: repoService as unknown as RepoLifecycleDeps['repos'],
    registry: registry as unknown as RepoLifecycleDeps['registry'],
    sessionPath: () => opts.sessionPath ?? null,
    versionStore: versionStore as unknown as RepoLifecycleDeps['versionStore'],
  };
  const lifecycle = new RepoLifecycle(deps);
  return {
    lifecycle,
    jobs,
    executor,
    registry,
    repoService,
    registryLoader,
    versionStore,
  };
}

const DETECTED: PluginResponse<unknown> = {
  success: true,
  data: { detected: true },
};
const NOT_DETECTED: PluginResponse<unknown> = {
  success: true,
  data: { detected: false },
};
const WATCH: PluginResponse<unknown> = {
  success: true,
  data: { config: ['foundry.toml'], sources: ['src'], artifacts: ['out'] },
};
const OK: PluginResponse<unknown> = { success: true, data: {} };

describe('RepoLifecycle', () => {
  it('pinned: materializes, detects, installs, compiles, and persists frameworks', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs, executor, repoService, registry, versionStore } =
        makeLifecycle({
          workspaceDir: dir,
          responses: {
            foundry: {
              detect: DETECTED,
              getWatchPaths: WATCH,
              install: OK,
              compile: OK,
            },
          },
        });
      const job = lifecycle.startPinnedLifecycle(
        'https://example.test/repo.git',
        'a'.repeat(40),
        'p1'
      );
      expect(job.params).toMatchObject({
        mode: 'pinned',
        url: 'https://example.test/repo.git',
        commit: 'a'.repeat(40),
      });
      await jobs.runAll();
      expect(repoService.withVersionMaterialized).toHaveBeenCalledWith(
        'p1',
        'https://example.test/repo.git',
        'a'.repeat(40),
        expect.objectContaining({ onLog: expect.any(Function) }),
        expect.any(Function)
      );
      expect(executor.calls.map((call) => call.op)).toEqual([
        'detect',
        'getWatchPaths',
        'install',
        'compile',
      ]);
      expect(registry.updates).toHaveLength(0);
      expect(versionStore.updateState).toHaveBeenCalledWith(
        'https://example.test/repo.git',
        'a'.repeat(40),
        expect.objectContaining({
          frameworks: [expect.objectContaining({ id: 'foundry' })],
          lastError: null,
          compiledWith: { pluginId: 'foundry', version: '1.0.0' },
        })
      );
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('exposes an awaitable pinned runner without creating a nested job', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });
      const result = await lifecycle.runPinnedLifecycle(
        'https://example.test/repo.git',
        'a'.repeat(40),
        'p1',
        { log: () => {}, signal: new AbortController().signal }
      );
      expect(result.frameworks).toEqual([
        expect.objectContaining({ id: 'foundry' }),
      ]);
      expect(jobs.started).toHaveLength(0);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });
  it('rebuilds a compiled version when its compiler plugin version changes', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, repoService, versionStore } = makeLifecycle({
        workspaceDir: dir,
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });
      versionStore.get.mockResolvedValue({
        compiledWith: { pluginId: 'foundry', version: '0.9.0' },
      } as never);
      await lifecycle.runPinnedLifecycle(
        'https://example.test/repo.git',
        'a'.repeat(40),
        'p1',
        { log: () => {}, signal: new AbortController().signal }
      );
      expect(repoService.withVersionMaterialized).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });
  it('keeps an awaitable pinned resolve visible to deletion until it settles', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, repoService } = makeLifecycle({
        workspaceDir: dir,
        pinnedPath: dir,
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });
      let release!: () => void;
      repoService.withVersionMaterialized.mockImplementationOnce(
        (_profileId, _url, _commit, _opts, fn) =>
          new Promise((resolve) => {
            release = () =>
              resolve(
                fn({
                  checkout: dir,
                  rematerialize: async () => ({ checkout: dir }),
                })
              );
          })
      );
      const running = lifecycle.runPinnedLifecycle(
        'https://example.test/repo.git',
        'a'.repeat(40),
        'p1',
        { log: () => {}, signal: new AbortController().signal }
      );
      expect(lifecycle.activeJobFor(dir)).toMatch(/^direct:/);
      release();
      await running;
      expect(lifecycle.activeJobFor(dir)).toBeUndefined();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });
  it('reports the real pinned add job id while activity is registered', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({ workspaceDir: dir });
      jobs.get.mockImplementation((id: string) => id === 'job-real' ? {
        id,
        type: 'repo.version.add',
        params: {},
        state: 'queued',
        createdAt: new Date().toISOString(),
        events: [],
      } : undefined);
      const release = lifecycle.beginPinnedActivity(
        'https://example.test/repo.git',
        'a'.repeat(40),
        'job-real'
      );

      expect(lifecycle.activeJobFor(dir)).toBe('job-real');
      release();
      expect(lifecycle.activeJobFor(dir)).toBeUndefined();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('shares direct activity across equivalent local and cloned repo spellings', () => {
    const { lifecycle } = makeLifecycle({ workspaceDir: '/workspace' });
    const releaseLocal = lifecycle.beginRepoActivity('/repo');
    const releaseCloned = lifecycle.beginRepoActivity(
      'https://github.com/example/contracts.git'
    );

    expect(lifecycle.activeJobFor('/repo/.')).toBe('direct:local:/repo');
    expect(lifecycle.activeJobFor('git@github.com:example/contracts.git')).toBe(
      'direct:cloned:https://github.com/example/contracts'
    );

    releaseLocal();
    releaseCloned();
  });

  it('keeps an earlier active pinned job visible when a later job settles first', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({ workspaceDir: dir });
      jobs.get.mockImplementation((id: string) => ({
        id,
        type: 'repo.version.add',
        params: {},
        state: 'queued',
        createdAt: new Date().toISOString(),
        events: [],
      }));
      const one = lifecycle.beginPinnedActivity('https://example.test/repo.git', 'a'.repeat(40), 'job-one');
      const two = lifecycle.beginPinnedActivity('https://example.test/repo.git', 'a'.repeat(40), 'job-two');

      two();
      expect(lifecycle.activeJobFor(dir)).toBe('job-one');
      one();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });
  it('sweep: init -> detect -> watchPaths -> persist, no install/compile', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs, executor, registry } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a' }],
        compilers: ['foundry', 'hardhat'],
        responses: {
          foundry: { detect: DETECTED, getWatchPaths: WATCH },
          hardhat: { detect: NOT_DETECTED },
        },
      });
      lifecycle.ensureProfileSwept('p1');
      await vi.waitFor(() => expect(jobs.started.length).toBeGreaterThan(0));
      await jobs.runAll();

      expect(executor.calls.map((c) => c.op)).toEqual(
        expect.arrayContaining(['detect', 'getWatchPaths'])
      );
      expect(executor.calls.some((c) => c.op === 'compile')).toBe(false);
      expect(executor.calls.some((c) => c.op === 'install')).toBe(false);

      expect(registry.updates).toHaveLength(1);
      const patch = registry.updates[0].patch;
      expect(patch.frameworks).toHaveLength(1);
      expect(patch.frameworks?.[0].id).toBe('foundry');
      expect(patch.frameworks?.[0].watchPaths?.sources).toEqual(['src']);
      expect(patch.detectedAt).toBeDefined();
      expect(patch.originUrl).toBe(`file://${dir}`);
      // Never compiled -> no fingerprint captured by a sweep.
      expect(patch.frameworks?.[0].fingerprint).toBeUndefined();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('persists a canonical remote origin during non-pinned lifecycle persistence', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs, registry, repoService } = makeLifecycle({
        workspaceDir: dir,
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      repoService.getVersionSource.mockResolvedValue({
        url: 'https://example.test/contracts.git/',
        workspacePath: dir,
        localFallbackPath: dir,
      });

      lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      await jobs.runAll();

      expect(registry.updates[0].patch.originUrl).toBe(
        'https://example.test/contracts.git'
      );
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('ensureProfileSwept is once per profile per run, and sweeps the session workspace', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a' }],
        sessionPath: '/ws/session',
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      lifecycle.ensureProfileSwept('p1');
      await vi.waitFor(() => expect(jobs.started.length).toBe(2)); // repo-a + session
      await jobs.runAll();
      lifecycle.ensureProfileSwept('p1');
      // allow any stray async work to surface
      await new Promise((r) => setTimeout(r, 20));
      expect(jobs.started.length).toBe(2);
      lifecycle.ensureProfileSwept('p2');
      await vi.waitFor(() => expect(jobs.started.length).toBeGreaterThan(2));
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('skips repos reserved for a direct mutation during profile sweeps', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a' }, { pathOrUrl: '/repo-b' }],
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      const release = lifecycle.beginRepoActivity('/repo-a');

      lifecycle.ensureProfileSwept('p1');
      await vi.waitFor(() => expect(jobs.started).toHaveLength(1));

      expect(jobs.started[0].record.params).toMatchObject({
        pathOrUrl: '/repo-b',
        mode: 'sweep',
      });
      release();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('resweepProfile re-runs a completed sweep (plugin catalog changed)', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a' }],
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      lifecycle.ensureProfileSwept('p1');
      await vi.waitFor(() => expect(jobs.started.length).toBe(1));
      await jobs.runAll();
      // A plain re-trigger is a no-op...
      lifecycle.ensureProfileSwept('p1');
      await new Promise((r) => setTimeout(r, 20));
      expect(jobs.started.length).toBe(1);
      // ...but a resweep after an install re-detects everything.
      lifecycle.resweepProfile('p1');
      await vi.waitFor(() => expect(jobs.started.length).toBe(2));
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('a detect ERROR keeps the previously-detected framework instead of clobbering it', async () => {
    const dir = await createTestDirectory();
    try {
      const priorFramework = {
        id: 'foundry',
        name: 'Foundry',
        watchPaths: {
          config: ['foundry.toml'],
          sources: ['src'],
          artifacts: ['out'],
        },
        fingerprint: { sources: 'abc', artifacts: 'def' },
      };
      const { lifecycle, jobs, registry } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a', frameworks: [priorFramework] }],
        responses: {
          foundry: {
            // e.g. the plugin image is missing or docker is contended.
            detect: {
              success: false,
              error: { code: 'BOOM', message: 'image not found' },
            },
            getWatchPaths: {
              success: false,
              error: { code: 'BOOM', message: 'image not found' },
            },
          },
        },
      });
      lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      await jobs.runAll();

      const patch = registry.updates.at(-1)?.patch;
      expect(patch?.frameworks?.map((f) => f.id)).toEqual(['foundry']);
      // Prior compile-time state carried over untouched.
      expect(patch?.frameworks?.[0].watchPaths).toEqual(
        priorFramework.watchPaths
      );
      expect(patch?.frameworks?.[0].fingerprint).toEqual(
        priorFramework.fingerprint
      );
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('a genuine "not detected" answer still clears the framework', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs, registry } = makeLifecycle({
        workspaceDir: dir,
        repos: [
          {
            pathOrUrl: '/repo-a',
            frameworks: [{ id: 'foundry', name: 'Foundry' }],
          },
        ],
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      await jobs.runAll();
      expect(registry.updates.at(-1)?.patch.frameworks).toEqual([]);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('add: install + compile for EVERY detected framework, fingerprint persisted', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const { lifecycle, jobs, executor, registry } = makeLifecycle({
        workspaceDir: dir,
        repos: [{ pathOrUrl: '/repo-a' }],
        compilers: ['foundry', 'hardhat'],
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
          hardhat: {
            detect: DETECTED,
            getWatchPaths: {
              success: true,
              data: {
                config: ['hardhat.config.ts'],
                sources: ['contracts'],
                artifacts: ['artifacts'],
              },
            },
            install: OK,
            compile: OK,
          },
        },
      });

      lifecycle.startLifecycle('/repo-a', 'p1', 'add');
      await jobs.runAll();

      const opsByPlugin = (id: string) =>
        executor.calls.filter((c) => c.pluginId === id).map((c) => c.op);
      expect(opsByPlugin('foundry')).toEqual(
        expect.arrayContaining([
          'detect',
          'getWatchPaths',
          'install',
          'compile',
        ])
      );
      expect(opsByPlugin('hardhat')).toEqual(
        expect.arrayContaining([
          'detect',
          'getWatchPaths',
          'install',
          'compile',
        ])
      );

      const fw = registry.updates[0].patch.frameworks;
      expect(fw).toHaveLength(2);
      for (const f of fw ?? []) {
        expect(f.compiledAt).toBeDefined();
        expect(f.fingerprint?.sources).toMatch(/^[0-9a-f]{64}$/);
        expect(f.fingerprint?.artifacts).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it.each(['add', 'pinned'] as const)(
    '%s: installs every detected framework before compiling any framework',
    async (mode) => {
      const dir = await createTestDirectory();
      try {
        const { lifecycle, jobs, executor } = makeLifecycle({
          workspaceDir: dir,
          compilers: ['foundry', 'hardhat'],
          responses: {
            foundry: {
              detect: DETECTED,
              getWatchPaths: WATCH,
              install: OK,
              compile: OK,
            },
            hardhat: {
              detect: DETECTED,
              getWatchPaths: WATCH,
              install: OK,
              compile: OK,
            },
          },
        });

        if (mode === 'pinned') {
          lifecycle.startPinnedLifecycle(
            'https://example.test/repo.git',
            'a'.repeat(40),
            'p1'
          );
        } else {
          lifecycle.startLifecycle('/repo-a', 'p1', mode);
        }
        await jobs.runAll();

        expect(
          executor.calls.map((call) => `${call.pluginId}:${call.op}`)
        ).toEqual([
          'foundry:detect',
          'hardhat:detect',
          'foundry:getWatchPaths',
          'hardhat:getWatchPaths',
          'foundry:install',
          'hardhat:install',
          'foundry:compile',
          'hardhat:compile',
        ]);
      } finally {
        await cleanupTestDirectory(dir);
      }
    }
  );

  it('recompile: installs all detected frameworks but compiles only drifted frameworks', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const { statFingerprint } = await import('../../repos/fingerprint.js');
      const cleanFingerprint = {
        sources: await statFingerprint(dir, ['hardhat.config.ts', 'contracts']),
        artifacts: await statFingerprint(dir, ['artifacts']),
      };
      const { lifecycle, jobs, executor } = makeLifecycle({
        workspaceDir: dir,
        repos: [
          {
            pathOrUrl: '/repo-a',
            frameworks: [
              {
                id: 'foundry',
                name: 'Foundry',
                watchPaths: {
                  config: ['foundry.toml'],
                  sources: ['src'],
                  artifacts: ['out'],
                },
                fingerprint: { sources: 'stale', artifacts: 'stale' },
                compiledAt: '2026-07-01T00:00:00.000Z',
              },
              {
                id: 'hardhat',
                name: 'Hardhat',
                watchPaths: {
                  config: ['hardhat.config.ts'],
                  sources: ['contracts'],
                  artifacts: ['artifacts'],
                },
                fingerprint: cleanFingerprint,
                compiledAt: '2026-07-01T00:00:00.000Z',
              },
            ],
          },
        ],
        compilers: ['foundry', 'hardhat'],
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
          hardhat: {
            detect: DETECTED,
            getWatchPaths: {
              success: true,
              data: {
                config: ['hardhat.config.ts'],
                sources: ['contracts'],
                artifacts: ['artifacts'],
              },
            },
            install: OK,
            compile: OK,
          },
        },
      });

      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A { uint x; }');
      lifecycle.startLifecycle('/repo-a', 'p1', 'recompile');
      await jobs.runAll();

      expect(
        executor.calls.map((call) => `${call.pluginId}:${call.op}`)
      ).toContain('foundry:install');
      expect(
        executor.calls.map((call) => `${call.pluginId}:${call.op}`)
      ).toContain('hardhat:install');
      expect(
        executor.calls.map((call) => `${call.pluginId}:${call.op}`)
      ).toContain('foundry:compile');
      expect(
        executor.calls.map((call) => `${call.pluginId}:${call.op}`)
      ).not.toContain('hardhat:compile');
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('recompile: compiles newly detected frameworks that have never been compiled', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs, executor } = makeLifecycle({
        workspaceDir: dir,
        repos: [
          {
            pathOrUrl: '/repo-a',
            frameworks: [
              {
                id: 'foundry',
                name: 'Foundry',
                compiledAt: '2026-07-01T00:00:00.000Z',
              },
            ],
          },
        ],
        compilers: ['foundry', 'hardhat'],
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
          hardhat: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });

      lifecycle.startLifecycle('/repo-a', 'p1', 'recompile');
      await jobs.runAll();

      expect(
        executor.calls.map((call) => `${call.pluginId}:${call.op}`)
      ).toContain('hardhat:compile');
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('recompile: skips installs when every detected framework is clean and already compiled', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const { statFingerprint } = await import('../../repos/fingerprint.js');
      const fingerprint = {
        sources: await statFingerprint(dir, ['foundry.toml', 'src']),
        artifacts: await statFingerprint(dir, ['out']),
      };
      const { lifecycle, jobs, executor } = makeLifecycle({
        workspaceDir: dir,
        repos: [
          {
            pathOrUrl: '/repo-a',
            frameworks: [
              {
                id: 'foundry',
                name: 'Foundry',
                watchPaths: {
                  config: ['foundry.toml'],
                  sources: ['src'],
                  artifacts: ['out'],
                },
                fingerprint,
                compiledAt: '2026-07-01T00:00:00.000Z',
              },
            ],
          },
        ],
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });

      lifecycle.startLifecycle('/repo-a', 'p1', 'recompile');
      await jobs.runAll();

      expect(
        executor.calls.some(
          (call) => call.op === 'install' || call.op === 'compile'
        )
      ).toBe(false);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('recompile: install runs before compile for a drifted framework (dependencies may be gone after a re-clone)', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const { statFingerprint } = await import('../../repos/fingerprint.js');
      const sources = await statFingerprint(dir, ['foundry.toml', 'src']);
      const artifacts = await statFingerprint(dir, ['out']);
      const record: RepoRecord = {
        pathOrUrl: '/repo-a',
        frameworks: [
          {
            id: 'foundry',
            name: 'Foundry',
            watchPaths: {
              config: ['foundry.toml'],
              sources: ['src'],
              artifacts: ['out'],
            },
            fingerprint: { sources, artifacts },
            compiledAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      };
      const { lifecycle, jobs, executor } = makeLifecycle({
        workspaceDir: dir,
        repos: [record],
        responses: {
          foundry: {
            detect: DETECTED,
            getWatchPaths: WATCH,
            install: OK,
            compile: OK,
          },
        },
      });

      // Drift the tree (e.g. a re-clone or manual node_modules wipe would
      // also leave watch-path fingerprints stale) so recompile actually
      // touches this framework.
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A { uint x; }');

      lifecycle.startLifecycle('/repo-a', 'p1', 'recompile');
      await jobs.runAll();

      const foundryOps = executor.calls
        .filter((c) => c.pluginId === 'foundry')
        .map((c) => c.op);
      expect(foundryOps).toContain('install');
      expect(foundryOps.indexOf('install')).toBeLessThan(
        foundryOps.indexOf('compile')
      );
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('startLifecycle returns the running job instead of starting a second for the same repo', async () => {
    const dir = await createTestDirectory();
    try {
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        responses: { foundry: { detect: NOT_DETECTED } },
      });
      const first = lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      const second = lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      expect(second.id).toBe(first.id);
      expect(jobs.started).toHaveLength(1);

      await jobs.runAll();
      const third = lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      expect(third.id).not.toBe(first.id);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('sweep preserves prior fingerprint/compiledAt instead of absorbing uncompiled changes', async () => {
    const dir = await createTestDirectory();
    try {
      const prior = {
        pathOrUrl: '/repo-a',
        frameworks: [
          {
            id: 'foundry',
            name: 'Foundry',
            watchPaths: {
              config: ['foundry.toml'],
              sources: ['src'],
              artifacts: ['out'],
            },
            fingerprint: { sources: 'aaa', artifacts: 'bbb' },
            compiledAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      };
      const { lifecycle, jobs, registry } = makeLifecycle({
        workspaceDir: dir,
        repos: [prior],
        responses: { foundry: { detect: DETECTED, getWatchPaths: WATCH } },
      });
      lifecycle.startLifecycle('/repo-a', 'p1', 'sweep');
      await jobs.runAll();
      const fw = registry.updates[0].patch.frameworks?.[0];
      // No compile happened this run: the stored at-last-compile fingerprint
      // must survive, or drift detection silently absorbs source changes.
      expect(fw?.fingerprint).toEqual({ sources: 'aaa', artifacts: 'bbb' });
      expect(fw?.compiledAt).toBe('2026-07-01T00:00:00.000Z');
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('checkAndRecompile starts recompile jobs only for drifted repos and honors cooldown', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const { statFingerprint } = await import('../../repos/fingerprint.js');
      const sources = await statFingerprint(dir, ['foundry.toml', 'src']);
      const artifacts = await statFingerprint(dir, ['out']);
      const record: RepoRecord = {
        pathOrUrl: '/repo-a',
        frameworks: [
          {
            id: 'foundry',
            name: 'Foundry',
            watchPaths: {
              config: ['foundry.toml'],
              sources: ['src'],
              artifacts: ['out'],
            },
            fingerprint: { sources, artifacts },
            compiledAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      };
      const { lifecycle, jobs } = makeLifecycle({
        workspaceDir: dir,
        repos: [record],
        responses: {
          foundry: { detect: DETECTED, getWatchPaths: WATCH, compile: OK },
        },
      });

      // Unchanged tree: nothing starts.
      const clean = await lifecycle.checkAndRecompile('p1');
      expect(clean.started).toEqual([]);

      // Change a source file -> drift. No-drift checks are not throttled
      // (they're cheap stat walks); the cooldown only starts once a
      // recompile job is actually started.
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A { uint x; }');
      const drifted = await lifecycle.checkAndRecompile('p1');
      expect(drifted.started).toHaveLength(1);
      expect(drifted.started[0].pathOrUrl).toBe('/repo-a');

      // Active job -> immediate re-check starts nothing.
      const during = await lifecycle.checkAndRecompile('p1');
      expect(during.started).toEqual([]);
      await jobs.runAll();
    } finally {
      await cleanupTestDirectory(dir);
    }
  });
});
