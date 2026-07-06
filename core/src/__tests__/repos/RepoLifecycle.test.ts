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
      type: PluginType.COMPILER,
      name: id[0].toUpperCase() + id.slice(1),
      version: '1.0.0',
      baseImage: `ignite/compiler_${id}:latest`,
    },
    requiresRepo: true,
    origin: 'builtin' as const,
  }));
}

function makeLifecycle(opts: {
  workspaceDir: string;
  repos?: RepoRecord[];
  compilers?: string[];
  responses?: Record<string, Record<string, PluginResponse<unknown>>>;
  sessionPath?: string | null;
}) {
  const jobs = makeFakeJobs();
  const executor = makeFakeExecutor(opts.responses ?? {});
  const updates: Array<{
    profileId: string;
    pathOrUrl: string;
    patch: Pick<RepoRecord, 'frameworks' | 'detectedAt'>;
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
        patch: Pick<RepoRecord, 'frameworks' | 'detectedAt'>
      ) => {
        updates.push({ profileId, pathOrUrl, patch });
      }
    ),
  };
  const repoService = {
    init: vi.fn(async () => ({ success: true as const, data: null })),
    resolveWorkspacePath: vi.fn(async () => opts.workspaceDir),
  };
  const registryLoader = {
    getPluginsByType: vi.fn(async () =>
      makeCompilerConfigs(opts.compilers ?? ['foundry'])
    ),
  };
  const deps: RepoLifecycleDeps = {
    jobs: jobs as unknown as RepoLifecycleDeps['jobs'],
    executor: executor as unknown as RepoLifecycleDeps['executor'],
    registryLoader:
      registryLoader as unknown as RepoLifecycleDeps['registryLoader'],
    repos: repoService as unknown as RepoLifecycleDeps['repos'],
    registry: registry as unknown as RepoLifecycleDeps['registry'],
    sessionPath: () => opts.sessionPath ?? null,
  };
  const lifecycle = new RepoLifecycle(deps);
  return { lifecycle, jobs, executor, registry, repoService, registryLoader };
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
      // Never compiled -> no fingerprint captured by a sweep.
      expect(patch.frameworks?.[0].fingerprint).toBeUndefined();
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
