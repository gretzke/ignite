import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PluginType } from '@ignite/plugin-types/types';
import {
  createCompilerHandlers,
  type CompilerExecutorLike,
  type CompilerJobManagerLike,
  type CompilerRegistryLoaderLike,
  type CompilerRepoServiceLike,
} from '../../api/plugins/compiler/index.js';
import { ErrorCodes } from '../../types/errors.js';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import type { JobContext, JobRunner } from '../../jobs/JobManager.js';
import { KeyedMutex } from '../../utils/KeyedMutex.js';
import { RepoLifecycle } from '../../repos/RepoLifecycle.js';

function makeCtx(log: (line: string) => void = () => {}): JobContext {
  return { log, signal: new AbortController().signal };
}

interface StartedJob {
  type: string;
  params: Record<string, unknown>;
  runner: JobRunner;
}

function makeFakeJobs(): CompilerJobManagerLike & { started: StartedJob[] } {
  const started: StartedJob[] = [];
  return {
    started,
    start: vi.fn(
      (type: string, params: Record<string, unknown>, runner: JobRunner) => {
        started.push({ type, params, runner });
        return {
          id: `job-${started.length - 1}`,
          type,
          params,
          state: 'queued' as const,
          createdAt: new Date().toISOString(),
          events: [],
        };
      }
    ) as CompilerJobManagerLike['start'],
  };
}

function makeConfig(id: string, name: string, type: PluginType): PluginConfig {
  return {
    metadata: {
      id,
      types: [type],
      name,
      version: '1.0.0',
      baseImage: `ignite/installed_${id}:1.0.0`,
    },
    repoRead: false,
    origin: 'builtin',
  };
}

const waffleConfig = makeConfig('waffle', 'Waffle', PluginType.COMPILER);
const hardhatConfig = makeConfig('hardhat', 'Hardhat', PluginType.COMPILER);
const nonCompilerConfig = makeConfig(
  'gitrepo',
  'GitRepo',
  'repo-manager' as unknown as PluginType
);

function makeFakeRegistry(
  configs: Record<string, PluginConfig>
): CompilerRegistryLoaderLike {
  return {
    getPluginConfig: vi.fn(async (pluginId: string) => {
      const config = configs[pluginId];
      if (!config) throw new Error(`Unknown plugin: ${pluginId}`);
      return config;
    }),
    getPluginsByType: vi.fn(async (type: PluginType) =>
      Object.values(configs).filter((c) => c.metadata.types.includes(type))
    ),
  };
}

// Deterministic fake: appends '-workspace' to the pathOrUrl so tests can
// assert the resolved value (not just that *some* string was passed) reached
// executor.execute.
function makeFakeRepos(
  overrides: Partial<CompilerRepoServiceLike> = {}
): CompilerRepoServiceLike {
  return {
    resolveExistingWorkspacePath: vi.fn(
      async (pathOrUrl: string) => `${pathOrUrl}-workspace`
    ),
    ensureVersion: vi.fn(async (_profileId: string, _url: string, _commit: string) => ({ checkout: 'unused-version-workspace' })),
    withRepoLifecycleLock: (async <T>(_pathOrUrl: string, _profileId: string | undefined, fn: () => Promise<T>): Promise<T> => fn()) as CompilerRepoServiceLike['withRepoLifecycleLock'],
    withVersionMaterialized: (async <T>(_profileId: string, _url: string, _commit: string, _opts: object, fn: (materialized: { checkout: string; rematerialize: () => Promise<{ checkout: string }> }) => Promise<T>) => fn({
      checkout: 'unused-version-workspace',
      rematerialize: async () => ({ checkout: 'unused-version-workspace' }),
    })) as CompilerRepoServiceLike['withVersionMaterialized'],
    ...overrides,
  };
}

describe('compiler API handlers (jobs)', () => {
  let app: FastifyInstance;
  let fakeJobs: ReturnType<typeof makeFakeJobs>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let registryLoader: CompilerRegistryLoaderLike;
  let repos: CompilerRepoServiceLike;

  beforeEach(async () => {
    fakeJobs = makeFakeJobs();
    executor = { execute: vi.fn() };
    registryLoader = makeFakeRegistry({
      waffle: waffleConfig,
      hardhat: hardhatConfig,
      gitrepo: nonCompilerConfig,
    });
    repos = makeFakeRepos();

    const handlers = createCompilerHandlers({
      jobs: fakeJobs,
      executor: executor as unknown as CompilerExecutorLike,
      registryLoader,
      repos,
    });

    app = fastify();
    app.post('/api/v1/detect', handlers.detect);
    app.post('/api/v1/install', handlers.install);
    app.post('/api/v1/compile', handlers.compile);
    app.post('/api/v1/artifacts/list', handlers.listArtifacts);
    app.post('/api/v1/artifacts/data', handlers.getArtifactData);
    await app.ready();
  });

  describe('detect', () => {
    it('returns { data: { jobId } } immediately without running the executor', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(fakeJobs.start).toHaveBeenCalledWith(
        'compiler.detect',
        { pathOrUrl: '/repo' },
        expect.any(Function)
      );
    });

    it('aggregates parallel per-plugin detects into { frameworks }', async () => {
      executor.execute.mockImplementation(
        async (
          pluginId: string,
          op: string,
          options: Record<string, unknown>
        ) => {
          if (pluginId === 'waffle') {
            return { success: true, data: { detected: true } };
          }
          if (pluginId === 'hardhat') {
            return { success: true, data: { detected: false } };
          }
          return { success: false, error: { code: 'X', message: 'nope' } };
        }
      );

      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());

      expect(result).toEqual({
        frameworks: [{ id: 'waffle', name: 'Waffle' }],
      });
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'detect',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
      expect(executor.execute).toHaveBeenCalledWith(
        'hardhat',
        'detect',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('fails the detect job when zero compiler plugins are available (broken catalog must be loud)', async () => {
      // A missing/empty plugin catalog previously produced a "succeeded"
      // job with frameworks: [] — every repo showed "Unknown Framework"
      // with no diagnostic. Zero available compilers is an installation
      // error, not an empty detection result.
      registryLoader = makeFakeRegistry({});
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        code: ErrorCodes.NO_COMPILER_PLUGINS,
      });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('fails the detect job when the plugin catalog cannot be loaded', async () => {
      registryLoader = {
        ...makeFakeRegistry({}),
        getPluginsByType: vi.fn(async () => {
          throw new Error('Built-in plugin catalog unavailable');
        }),
      };
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toThrow(/catalog unavailable/);
    });

    it('resolves workspacePath once via RepoService, before the job is created', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledTimes(1);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo');
    });

    it('returns 400 synchronously when the workspace cannot be resolved (no job created)', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('wires onOutput through to ctx.log', async () => {
      executor.execute.mockImplementation(
        async (
          _pluginId: string,
          _op: string,
          _options: Record<string, unknown>,
          opts?: { onOutput?: (text: string) => void }
        ) => {
          opts?.onOutput?.('building...');
          return { success: true, data: { detected: false } };
        }
      );

      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const logs: string[] = [];
      const { runner } = fakeJobs.started[0];
      await runner(makeCtx((line) => logs.push(line)));

      expect(logs).toContain('building...');
    });
  });

  describe('install', () => {
    it('returns 400 synchronously for an unknown plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.UNKNOWN_PLUGIN);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('returns 400 synchronously for a non-compiler plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'gitrepo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.NOT_A_COMPILER_PLUGIN);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('starts a job and returns { data: { jobId } } immediately without awaiting the runner', async () => {
      executor.execute.mockImplementation(async () => {
        throw new Error('should not run synchronously');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(fakeJobs.start).toHaveBeenCalledWith(
        'compiler.install',
        { pathOrUrl: '/repo', pluginId: 'waffle' },
        expect.any(Function)
      );
    });

    it('runner calls execute with onOutput and resolves null on success', async () => {
      executor.execute.mockResolvedValue({ success: true, data: null });

      await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());
      expect(result).toBeNull();
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'install',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved (no job created)', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/install', handlers.install);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('runner rejects with { code, message, details } when the executor reports failure', async () => {
      executor.execute.mockResolvedValue({
        success: false,
        error: {
          code: 'PERMISSION_REQUIRED',
          message: 'Plugin waffle requires the docker permission',
          details: { pluginId: 'waffle', permission: 'docker' },
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        message: 'Plugin waffle requires the docker permission',
        code: 'PERMISSION_REQUIRED',
        details: { pluginId: 'waffle', permission: 'docker' },
      });
    });

    it('refuses a raw version-cache workspace without a pin', async () => {
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
        versionStore: { isCachePath: vi.fn(() => true), checkoutPath: vi.fn() } as never,
      });
      const localApp = fastify();
      localApp.post('/api/v1/install', handlers.install);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST', url: '/api/v1/install',
        payload: { pathOrUrl: '/cache/version', pluginId: 'waffle' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.VERSION_WORKSPACE_PIN_REQUIRED);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('rematerializes a pinned workspace inside the version lock before installing', async () => {
      const pin = { url: 'https://example.test/repo.git', commit: 'a'.repeat(40), ref: 'v1', refKind: 'tag' };
      const requestTimeCheckout = '/cache/repo/versions/deleted-' + pin.commit;
      const rematerializedCheckout = '/cache/repo/versions/' + pin.commit;
      const withVersionMaterialized = vi.fn(async (
        _profileId: string,
        _url: string,
        _commit: string,
        _opts: object,
        fn: (materialized: { checkout: string; rematerialize: () => Promise<{ checkout: string }> }) => Promise<unknown>
      ) => fn({
        checkout: rematerializedCheckout,
        rematerialize: async () => ({ checkout: rematerializedCheckout }),
      }));
      repos = makeFakeRepos({
        ensureVersion: vi.fn(async () => ({ checkout: requestTimeCheckout })),
        withVersionMaterialized: withVersionMaterialized as never,
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
        versionStore: { isCachePath: vi.fn(() => true), checkoutPath: vi.fn(() => requestTimeCheckout) } as never,
      });
      const localApp = fastify();
      localApp.post('/api/v1/install', handlers.install);
      await localApp.ready();
      executor.execute.mockResolvedValue({ success: true, data: null });

      const res = await localApp.inject({
        method: 'POST', url: '/api/v1/install',
        payload: { pathOrUrl: pin.url, pluginId: 'waffle', pin },
      });
      expect(res.statusCode).toBe(200);
      await fakeJobs.started[0].runner(makeCtx());
      expect(withVersionMaterialized).toHaveBeenCalledWith(
        expect.any(String),
        pin.url,
        pin.commit,
        { ref: pin.ref, refLabel: pin.ref, refKind: pin.refKind },
        expect.any(Function)
      );
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'install',
        { pathOrUrl: pin.url },
        expect.objectContaining({ workspacePath: rematerializedCheckout })
      );
    });
  });

  describe('compile', () => {
    it('runs a live manual compile under the lifecycle repo lock', async () => {
      executor.execute.mockResolvedValue({ success: true, data: null });
      const withRepoLifecycleLock = vi.fn(async (_pathOrUrl: string, _profileId: string | undefined, fn: () => Promise<unknown>) => fn());
      repos = makeFakeRepos({ withRepoLifecycleLock: withRepoLifecycleLock as never });
      const handlers = createCompilerHandlers({ jobs: fakeJobs, executor: executor as never, registryLoader, repos });
      const localApp = fastify();
      localApp.post('/api/v1/compile', handlers.compile);
      await localApp.ready();

      await localApp.inject({ method: 'POST', url: '/api/v1/compile', payload: { pathOrUrl: '/repo', pluginId: 'waffle' } });
      await fakeJobs.started[0].runner(makeCtx());
      expect(withRepoLifecycleLock).toHaveBeenCalledWith('/repo', undefined, expect.any(Function));
    });

    it('serializes a manual live compile with an automatic live recompile', async () => {
      const mutex = new KeyedMutex();
      const order: string[] = [];
      let releaseManualCompile!: () => void;
      const manualCompileGate = new Promise<void>((resolve) => { releaseManualCompile = resolve; });
      let compileCalls = 0;
      const withRepoLifecycleLock = vi.fn(<T,>(_pathOrUrl: string, _profileId: string | undefined, fn: () => Promise<T>) =>
        mutex.run('repo:/repo', fn)
      ) as CompilerRepoServiceLike['withRepoLifecycleLock'];
      repos = makeFakeRepos({ withRepoLifecycleLock });
      Object.assign(repos, {
        init: vi.fn(async () => ({ success: true, data: null })),
        resolveWorkspacePath: vi.fn(async () => '/repo-workspace'),
        getVersionSource: vi.fn(async () => ({ url: 'file:///repo', workspacePath: '/repo-workspace' })),
      });
      executor.execute.mockImplementation(async (_pluginId: string, operation: string) => {
        if (operation === 'detect') {
          order.push('automatic detect');
          return { success: true, data: { detected: true } };
        }
        if (operation === 'getWatchPaths') {
          return { success: true, data: { config: [], sources: [], artifacts: [] } };
        }
        if (operation === 'compile') {
          compileCalls += 1;
          if (compileCalls === 1) {
            order.push('manual compile start');
            await manualCompileGate;
            order.push('manual compile end');
          }
          return { success: true, data: null };
        }
        return { success: true, data: null };
      });
      const handlers = createCompilerHandlers({ jobs: fakeJobs, executor: executor as never, registryLoader, repos });
      const localApp = fastify();
      localApp.post('/api/v1/compile', handlers.compile);
      await localApp.ready();
      await localApp.inject({ method: 'POST', url: '/api/v1/compile', payload: { pathOrUrl: '/repo', pluginId: 'waffle' } });

      let automaticRunner!: JobRunner;
      const lifecycle = new RepoLifecycle({
        jobs: {
          start: vi.fn((_type: string, _params: Record<string, unknown>, runner: JobRunner) => {
            automaticRunner = runner;
            return { id: 'automatic', type: 'repo.lifecycle', params: {}, state: 'queued' as const, createdAt: new Date().toISOString(), events: [] };
          }),
          get: vi.fn(() => undefined),
        } as never,
        executor: executor as never,
        registryLoader: registryLoader as never,
        repos: repos as never,
        registry: { list: vi.fn(async () => ({ local: [], cloned: [] })), updateRepoState: vi.fn(async () => {}) } as never,
        sessionPath: () => null,
        versionStore: { checkoutPath: vi.fn(), get: vi.fn(), updateState: vi.fn() } as never,
      });

      const manual = fakeJobs.started[0].runner(makeCtx());
      await vi.waitFor(() => expect(order).toEqual(['manual compile start']));
      lifecycle.startLifecycle('/repo', 'p1', 'recompile');
      const automatic = automaticRunner(makeCtx());
      await Promise.resolve();
      expect(order).toEqual(['manual compile start']);

      releaseManualCompile();
      await Promise.all([manual, automatic]);
      expect(order).toEqual([
        'manual compile start',
        'manual compile end',
        'automatic detect',
        'automatic detect',
      ]);
    });

    it('serializes a manual pinned compile with pinned lifecycle work in group then checkout order', async () => {
      const pin = { url: 'https://example.test/repo.git', commit: 'a'.repeat(40), ref: 'v1', refKind: 'tag' as const };
      const mutex = new KeyedMutex();
      const groupKey = `group:${pin.url}`;
      const checkoutKey = `checkout:${pin.url}:${pin.commit}`;
      const order: string[] = [];
      let materializations = 0;
      let releaseManualCompile!: () => void;
      const manualCompileGate = new Promise<void>((resolve) => { releaseManualCompile = resolve; });
      let compileCalls = 0;
      const withVersionMaterialized = vi.fn(async <T>(
        _profileId: string,
        _url: string,
        _commit: string,
        _opts: object,
        fn: (materialized: { checkout: string; rematerialize: () => Promise<{ checkout: string }> }) => Promise<T>
      ): Promise<T> => {
        const label = materializations++ === 0 ? 'manual' : 'automatic';
        return mutex.run(groupKey, async () => {
          order.push(`${label} group`);
          return mutex.run(checkoutKey, async () => {
            order.push(`${label} checkout`);
            return fn({ checkout: '/versions/pin', rematerialize: async () => ({ checkout: '/versions/pin' }) });
          });
        });
      });
      repos = makeFakeRepos({
        ensureVersion: vi.fn(async () => ({ checkout: '/versions/pin' })),
        withVersionMaterialized: withVersionMaterialized as never,
      });
      executor.execute.mockImplementation(async (_pluginId: string, operation: string) => {
        if (operation === 'detect') {
          order.push('automatic detect');
          return { success: true, data: { detected: true } };
        }
        if (operation === 'getWatchPaths') return { success: true, data: { config: [], sources: [], artifacts: [] } };
        if (operation === 'compile') {
          compileCalls += 1;
          if (compileCalls === 1) {
            order.push('manual compile start');
            await manualCompileGate;
            order.push('manual compile end');
          }
        }
        return { success: true, data: null };
      });
      const versionStore = { isCachePath: vi.fn(() => false), checkoutPath: vi.fn(() => '/versions/pin') };
      const handlers = createCompilerHandlers({ jobs: fakeJobs, executor: executor as never, registryLoader, repos, versionStore: versionStore as never });
      const localApp = fastify();
      localApp.post('/api/v1/compile', handlers.compile);
      await localApp.ready();
      await localApp.inject({ method: 'POST', url: '/api/v1/compile', payload: { pathOrUrl: pin.url, pluginId: 'waffle', pin } });
      const lifecycle = new RepoLifecycle({
        jobs: { start: vi.fn(), get: vi.fn() } as never,
        executor: executor as never,
        registryLoader: registryLoader as never,
        repos: repos as never,
        registry: { list: vi.fn(async () => ({ local: [], cloned: [] })), updateRepoState: vi.fn(async () => {}) } as never,
        sessionPath: () => null,
        versionStore: { checkoutPath: vi.fn(() => '/versions/pin'), get: vi.fn(async () => undefined), updateState: vi.fn(async () => {}) } as never,
      });

      const manual = fakeJobs.started[0].runner(makeCtx());
      await vi.waitFor(() => expect(order).toContain('manual compile start'));
      const automatic = lifecycle.runPinnedLifecycle(pin.url, pin.commit, 'p1', makeCtx());
      await Promise.resolve();
      expect(order).toEqual(['manual group', 'manual checkout', 'manual compile start']);

      releaseManualCompile();
      await Promise.all([manual, automatic]);
      expect(order.indexOf('manual compile end')).toBeLessThan(order.indexOf('automatic group'));
      expect(order).toEqual(expect.arrayContaining([
        'automatic group',
        'automatic checkout',
        'automatic detect',
      ]));
    });

    it('starts a job and returns { data: { jobId } } immediately', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('runner calls execute with onOutput and resolves null on success', async () => {
      executor.execute.mockResolvedValue({ success: true, data: null });

      await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());
      expect(result).toBeNull();
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'compile',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('runner rejects with the plugin error code on failure', async () => {
      executor.execute.mockResolvedValue({
        success: false,
        error: { code: 'COMPILE_FAILED', message: 'syntax error' },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        code: 'COMPILE_FAILED',
        message: 'syntax error',
      });
    });

    it('rematerializes a pinned workspace inside the version lock before compiling', async () => {
      const pin = { url: 'https://example.test/repo.git', commit: 'a'.repeat(40), ref: 'v1', refKind: 'tag' };
      const requestTimeCheckout = '/cache/repo/versions/deleted-' + pin.commit;
      const rematerializedCheckout = '/cache/repo/versions/' + pin.commit;
      const withVersionMaterialized = vi.fn(async (
        _profileId: string,
        _url: string,
        _commit: string,
        _opts: object,
        fn: (materialized: { checkout: string; rematerialize: () => Promise<{ checkout: string }> }) => Promise<unknown>
      ) => fn({
        checkout: rematerializedCheckout,
        rematerialize: async () => ({ checkout: rematerializedCheckout }),
      }));
      repos = makeFakeRepos({
        ensureVersion: vi.fn(async () => ({ checkout: requestTimeCheckout })),
        withVersionMaterialized: withVersionMaterialized as never,
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
        versionStore: { isCachePath: vi.fn(() => true), checkoutPath: vi.fn(() => requestTimeCheckout) } as never,
      });
      const localApp = fastify();
      localApp.post('/api/v1/compile', handlers.compile);
      await localApp.ready();
      executor.execute.mockResolvedValue({ success: true, data: null });

      const res = await localApp.inject({
        method: 'POST', url: '/api/v1/compile',
        payload: { pathOrUrl: pin.url, pluginId: 'waffle', pin },
      });
      expect(res.statusCode).toBe(200);
      await fakeJobs.started[0].runner(makeCtx());
      expect(withVersionMaterialized).toHaveBeenCalledWith(
        expect.any(String),
        pin.url,
        pin.commit,
        { ref: pin.ref, refLabel: pin.ref, refKind: pin.refKind },
        expect.any(Function)
      );
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'compile',
        { pathOrUrl: pin.url },
        expect.objectContaining({ workspacePath: rematerializedCheckout })
      );
    });

    it('returns 400 synchronously for a non-compiler plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'gitrepo' },
      });
      expect(res.statusCode).toBe(400);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });
  });

  describe('listArtifacts', () => {
    it('resolves workspacePath and passes it through executor.execute', async () => {
      executor.execute.mockResolvedValue({
        success: true,
        data: { artifacts: [] },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/artifacts/list',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(200);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo');
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'listArtifacts',
        { pathOrUrl: '/repo' },
        { workspacePath: '/repo-workspace' }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/artifacts/list', handlers.listArtifacts);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/artifacts/list',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('lists artifacts from the materialized pinned commit instead of the live workspace', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-list-pinned-'));
      const live = path.join(root, 'live');
      const pinned = path.join(root, 'pinned');
      try {
        await fs.mkdir(path.join(live, 'contracts'), { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: live });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: live });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: live });
        await fs.writeFile(path.join(live, 'contracts', 'PinnedOnly.sol'), 'contract PinnedOnly {}\n');
        execFileSync('git', ['add', '.'], { cwd: live });
        execFileSync('git', ['commit', '-q', '-m', 'pinned'], { cwd: live });
        const pinnedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: live, encoding: 'utf8' }).trim();
        await fs.rm(path.join(live, 'contracts', 'PinnedOnly.sol'));
        await fs.writeFile(path.join(live, 'contracts', 'LiveOnly.sol'), 'contract LiveOnly {}\n');
        execFileSync('git', ['add', '-A'], { cwd: live });
        execFileSync('git', ['commit', '-q', '-m', 'live'], { cwd: live });
        execFileSync('git', ['worktree', 'add', '--quiet', '--detach', pinned, pinnedCommit], { cwd: live });

        const pinnedRepos = makeFakeRepos({
          resolveExistingWorkspacePath: vi.fn(async () => live),
          withVersionMaterialized: vi.fn(async (_profileId, _url, _commit, _opts, fn) => fn({
            checkout: pinned,
            rematerialize: async () => ({ checkout: pinned }),
          })) as never,
        });
        const pinnedExecutor = {
          execute: vi.fn(async (_pluginId: string, operation: string, _input: unknown, options: { workspacePath: string }) => {
            const names = await fs.readdir(path.join(options.workspacePath, 'contracts'));
            return { success: true, data: { artifacts: names.map((name) => ({ contractName: name.replace(/\.sol$/, ''), sourcePath: `contracts/${name}`, artifactPath: `out/${name}.json` })) }, operation };
          }),
        };
        const handlers = createCompilerHandlers({
          jobs: fakeJobs,
          executor: pinnedExecutor as unknown as CompilerExecutorLike,
          registryLoader,
          repos: pinnedRepos,
        });
        const localApp = fastify();
        localApp.post('/api/v1/artifacts/list', handlers.listArtifacts);
        await localApp.ready();
        const pin = { url: 'https://example.test/contracts.git', commit: pinnedCommit };
        const res = await localApp.inject({ method: 'POST', url: '/api/v1/artifacts/list', payload: { pathOrUrl: pin.url, pluginId: 'waffle', pin } });

        expect(res.statusCode).toBe(200);
        expect(res.json().data.artifacts.map((item: { contractName: string }) => item.contractName)).toEqual(['PinnedOnly']);
        expect(pinnedExecutor.execute).toHaveBeenCalledWith('waffle', 'listArtifacts', { pathOrUrl: pin.url }, { workspacePath: pinned });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('getArtifactData', () => {
    it('resolves workspacePath and passes it through executor.execute', async () => {
      executor.execute.mockResolvedValue({
        success: true,
        data: { content: 'abi json' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/artifacts/data',
        payload: {
          pathOrUrl: '/repo',
          pluginId: 'waffle',
          artifactPath: 'out/Foo.json',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo', 'default');
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'getArtifactData',
        { pathOrUrl: '/repo', artifactPath: 'out/Foo.json' },
        { workspacePath: '/repo-workspace' }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/artifacts/data', handlers.getArtifactData);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/artifacts/data',
        payload: {
          pathOrUrl: '/repo',
          pluginId: 'waffle',
          artifactPath: 'out/Foo.json',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('returns VERSION_ORIGIN_UNAPPROVED from getArtifactData instead of INIT_ERROR', async () => {
      repos = makeFakeRepos({
        withVersionMaterialized: vi.fn(async () => {
          throw Object.assign(new Error('origin approval required'), {
            code: ErrorCodes.VERSION_ORIGIN_UNAPPROVED,
          });
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/artifacts/data', handlers.getArtifactData);
      await localApp.ready();
      const res = await localApp.inject({
        method: 'POST', url: '/api/v1/artifacts/data',
        payload: {
          pathOrUrl: 'https://example.test/repo.git', pluginId: 'waffle', artifactPath: 'out/C.json',
          pin: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.VERSION_ORIGIN_UNAPPROVED);
    });
  });
});
